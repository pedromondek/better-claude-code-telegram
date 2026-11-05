#![allow(
    dead_code,
    reason = "each test binary uses a different part of the support"
)]

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use serde_json::{Map, Value};

pub(crate) const PRIVATE_FILE_MODE: &str = "600";

pub(crate) type Tree = BTreeMap<String, (Option<String>, String)>;

pub(crate) fn parse(source: &str) -> Value {
    serde_json::from_str(source).unwrap()
}

pub(crate) fn list<'a>(fixture: &'a Value, key: &str) -> &'a Vec<Value> {
    fixture[key].as_array().unwrap()
}

pub(crate) fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap()
}

pub(crate) fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap().to_owned())
        .collect()
}

pub(crate) fn repo_root() -> PathBuf {
    fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")).unwrap()
}

pub(crate) fn substitute(text: &str, root: &Path) -> String {
    text.replace("{root}", &root.to_string_lossy())
        .replace("{repo}", &repo_root().to_string_lossy())
}

pub(crate) fn placeholders(text: &str, root: &Path) -> String {
    text.replace(&*root.to_string_lossy(), "{root}")
        .replace(&*repo_root().to_string_lossy(), "{repo}")
}

pub(crate) fn sandbox() -> tempfile::TempDir {
    tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}

pub(crate) fn default_file_mode() -> String {
    let folder = tempfile::tempdir().unwrap();
    let probe = folder.path().join("probe");
    fs::File::create(&probe).unwrap();

    format!(
        "{:o}",
        fs::metadata(probe).unwrap().permissions().mode() & 0o777
    )
}

fn ensure_folder(root: &Path, folder: &Path) {
    let mut current = root.to_path_buf();

    for part in folder.strip_prefix(root).unwrap().components() {
        current.push(part);

        if fs::symlink_metadata(&current).is_err() {
            fs::create_dir(&current).unwrap();
            fs::set_permissions(&current, fs::Permissions::from_mode(0o750)).unwrap();
        }
    }
}

pub(crate) fn body_of(spec: &Value, root: &Path) -> Vec<u8> {
    if let Some(content) = spec.as_str() {
        return substitute(content, root).into_bytes();
    }

    if let Some(bytes) = spec.get("bytes") {
        return bytes
            .as_array()
            .unwrap()
            .iter()
            .map(|byte| u8::try_from(byte.as_u64().unwrap()).unwrap())
            .collect();
    }

    substitute(
        spec.get("content").and_then(Value::as_str).unwrap_or(""),
        root,
    )
    .into_bytes()
}

pub(crate) fn materialize(root: &Path, files: &Value) {
    for (path, spec) in files.as_object().unwrap() {
        let target = root.join(path);

        if path.ends_with('/') {
            ensure_folder(root, &target);
            continue;
        }

        ensure_folder(root, target.parent().unwrap());
        fs::write(&target, body_of(spec, root)).unwrap();

        let mode = spec
            .get("mode")
            .and_then(Value::as_u64)
            .map_or(0o600, |mode| u32::try_from(mode).unwrap());
        fs::set_permissions(&target, fs::Permissions::from_mode(mode)).unwrap();
    }
}

fn walk(root: &Path, folder: &Path, out: &mut Tree) {
    let mut names: Vec<_> = fs::read_dir(folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    names.sort();

    for name in names {
        let full = folder.join(name);
        let relative = full
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let metadata = fs::symlink_metadata(&full).unwrap();
        let mode = format!("{:o}", metadata.permissions().mode() & 0o777);

        if metadata.is_dir() {
            out.insert(format!("{relative}/"), (None, mode));
            walk(root, &full, out);
        } else {
            let content = String::from_utf8_lossy(&fs::read(&full).unwrap()).into_owned();
            out.insert(relative, (Some(placeholders(&content, root)), mode));
        }
    }
}

pub(crate) fn snapshot(root: &Path) -> Tree {
    let mut out = Tree::new();
    walk(root, root, &mut out);
    out
}

pub(crate) fn snapshot_under(root: &Path, folder: &str) -> Tree {
    let mut out = Tree::new();
    walk(root, &root.join(folder), &mut out);
    out
}

pub(crate) fn expected_tree(after: &Value, written: Option<&Value>, default_mode: &str) -> Tree {
    let written: BTreeSet<&str> = written
        .and_then(Value::as_array)
        .map(|paths| paths.iter().map(|path| path.as_str().unwrap()).collect())
        .unwrap_or_default();

    after
        .as_object()
        .unwrap()
        .iter()
        .map(|(path, entry)| {
            let mode = match text(entry, "mode") {
                _ if written.contains(path.as_str()) => PRIVATE_FILE_MODE,
                "644" => default_mode,
                mode => mode,
            };

            (
                path.clone(),
                (
                    entry
                        .get("content")
                        .map(|content| content.as_str().unwrap().to_owned()),
                    mode.to_owned(),
                ),
            )
        })
        .collect()
}

pub(crate) fn environment(env: &Value, root: &Path) -> HashMap<String, OsString> {
    env.as_object()
        .unwrap()
        .iter()
        .map(|(name, value)| {
            (
                name.clone(),
                OsString::from(substitute(value.as_str().unwrap(), root)),
            )
        })
        .collect()
}

pub(crate) fn lookup(
    variables: &HashMap<String, OsString>,
) -> impl Fn(&str) -> Option<OsString> + '_ {
    |name| variables.get(name).cloned()
}

pub(crate) fn home(variables: &HashMap<String, OsString>) -> PathBuf {
    variables.get("HOME").map(PathBuf::from).unwrap_or_default()
}

pub(crate) fn coverage_env() -> Vec<(&'static str, OsString)> {
    std::env::var_os("LLVM_PROFILE_FILE")
        .map(|file| ("LLVM_PROFILE_FILE", file))
        .into_iter()
        .collect()
}

pub(crate) fn object(value: &Value) -> &Map<String, Value> {
    value.as_object().unwrap()
}

pub(crate) struct Helper {
    child: Child,
}

impl Helper {
    pub(crate) fn start(name: &str) -> Self {
        let helper = Self {
            child: Command::new("sh")
                .args(["-c", "sleep 600; :", name])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        };

        for _ in 0..200 {
            let output = Command::new("ps")
                .args(["-p", &helper.pid(), "-o", "args="])
                .output()
                .unwrap();

            if String::from_utf8_lossy(&output.stdout).contains(name) {
                return helper;
            }

            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        panic!("the helper process never showed up");
    }

    pub(crate) fn pid(&self) -> String {
        self.child.id().to_string()
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _killed = self.child.kill();
        let _waited = self.child.wait();
    }
}

pub(crate) fn dead_pid() -> String {
    let mut child = Command::new("true").spawn().unwrap();
    child.wait().unwrap();
    child.id().to_string()
}
