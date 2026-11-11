use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use semver::Version;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::js::stringify_pretty;
use crate::messages::{Messages, messages_for};
use crate::paths::Paths;
use crate::setup::setup_locale;

pub const LAUNCHER_SH: &str = r#"#!/bin/sh
bin_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
current=$(cat "$bin_dir/current" 2>/dev/null)
binary="$bin_dir/versions/$current/bcct"
if [ -z "$current" ] || [ ! -x "$binary" ]; then
  echo 'bcct: no installed version found. Run: npx better-claude-code-telegram' >&2
  echo 'bcct: nenhuma versão instalada encontrada. Rode: npx better-claude-code-telegram' >&2
  exit 127
fi
exec "$binary" "$@"
"#;

pub const LAUNCHER_CMD: &str = concat!(
    "@echo off\r\n",
    "setlocal\r\n",
    "set \"current=\"\r\n",
    "if exist \"%~dp0current\" set /p current=<\"%~dp0current\"\r\n",
    "if not defined current goto missing\r\n",
    "set \"current=%current:/=\\%\"\r\n",
    "if not exist \"%~dp0versions\\%current%\\bcct.exe\" goto missing\r\n",
    "\"%~dp0versions\\%current%\\bcct.exe\" %*\r\n",
    "exit /b %errorlevel%\r\n",
    ":missing\r\n",
    "echo bcct: no installed version found. Run: npx better-claude-code-telegram 1>&2\r\n",
    "echo bcct: nenhuma versao instalada encontrada. Rode: npx better-claude-code-telegram 1>&2\r\n",
    "exit /b 127\r\n",
);

const BIN_FOLDER: &str = "bin";
const VERSIONS_FOLDER: &str = "versions";
const CURRENT_FILE: &str = "current";
const RECEIPT_FILE: &str = "install.json";
const VERIFIED_FILE: &str = ".verified";
const LAUNCHER_SH_FILE: &str = "bcct";
const LAUNCHER_CMD_FILE: &str = "bcct.cmd";
const BINARY_FILE: &str = if cfg!(windows) { "bcct.exe" } else { "bcct" };
const LAUNCHER_FILE: &str = if cfg!(windows) {
    LAUNCHER_CMD_FILE
} else {
    LAUNCHER_SH_FILE
};
const KEPT_PER_FOLDER: usize = 2;
const EXECUTABLE_MODE: u32 = 0o755;
const PRIVATE_MODE: u32 = 0o600;
const VERSION_PREFIX: &str = "bcct ";
const SUCCESS: u8 = 0;
const FAILURE: u8 = 1;
const USAGE: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Beta,
    Alpha,
}

impl Channel {
    pub const ALL: [Self; 3] = [Self::Stable, Self::Beta, Self::Alpha];

    #[must_use]
    pub fn of(version: &str) -> Self {
        match version.split_once('-') {
            None => Self::Stable,
            Some((_, suffix)) if suffix.starts_with("alpha") => Self::Alpha,
            Some(_) => Self::Beta,
        }
    }

    #[must_use]
    pub fn folder(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "unstable/beta",
            Self::Alpha => "unstable/alpha",
        }
    }

    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
            Self::Alpha => "alpha",
        }
    }

    #[must_use]
    pub fn is_unstable(self) -> bool {
        self != Self::Stable
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Npm,
    Release,
    Manual,
}

impl Origin {
    fn name(self) -> &'static str {
        match self {
            Self::Npm => "npm",
            Self::Release => "release",
            Self::Manual => "manual",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        [Self::Npm, Self::Release, Self::Manual]
            .into_iter()
            .find(|origin| origin.name() == text)
    }
}

#[derive(Debug)]
pub enum InstallError {
    HashMismatch,
    NotBcct,
    Io(io::Error),
}

impl From<io::Error> for InstallError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub version: String,
    pub channel: Channel,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveVersion {
    pub channel: String,
    pub version: String,
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }

    #[cfg(not(unix))]
    {
        metadata.is_file()
    }
}

#[derive(Debug, Clone)]
pub struct Store {
    bin: PathBuf,
}

impl Store {
    #[must_use]
    pub fn new(app_dir: &Path) -> Self {
        Self {
            bin: app_dir.join(BIN_FOLDER),
        }
    }

    pub fn install(
        &self,
        source: &Path,
        sha256: &str,
        origin: Origin,
    ) -> Result<Installed, InstallError> {
        let bytes = fs::read(source)?;
        let hash = hex_digest(&bytes);

        if !hash.eq_ignore_ascii_case(sha256.trim()) {
            return Err(InstallError::HashMismatch);
        }

        let versions = self.bin.join(VERSIONS_FOLDER);
        fs::create_dir_all(&versions)?;

        let staging = tempfile::Builder::new()
            .prefix(".staging-")
            .tempdir_in(&versions)?;
        let staged = staging.path().join(BINARY_FILE);
        fs::write(&staged, &bytes)?;
        set_mode(&staged, EXECUTABLE_MODE)?;

        let version = answered_version(&staged).ok_or(InstallError::NotBcct)?;
        let channel = Channel::of(&version);
        fs::write(staging.path().join(VERIFIED_FILE), format!("{hash}\n"))?;

        let channel_dir = versions.join(channel.folder());
        fs::create_dir_all(&channel_dir)?;
        let target = channel_dir.join(&version);

        if !verified_as(&target, &hash) {
            replace_dir(&staging.keep(), &target)?;
        }

        let current = format!("{}/{version}\n", channel.folder());
        let fields = receipt(origin, &version, channel);

        let files = [
            (CURRENT_FILE, current.as_str(), PRIVATE_MODE),
            (RECEIPT_FILE, fields.as_str(), PRIVATE_MODE),
            (LAUNCHER_SH_FILE, LAUNCHER_SH, EXECUTABLE_MODE),
            (LAUNCHER_CMD_FILE, LAUNCHER_CMD, EXECUTABLE_MODE),
        ];

        for (name, contents, mode) in files {
            write_if_changed(&self.bin.join(name), contents, mode)?;
        }

        prune(&channel_dir, &version)?;

        Ok(Installed { version, channel })
    }

    #[must_use]
    pub fn active(&self) -> Option<ActiveVersion> {
        let text = fs::read_to_string(self.bin.join(CURRENT_FILE)).ok()?;
        let (folder, version) = text.trim().rsplit_once('/')?;
        let channel = folder.rsplit('/').next().unwrap_or(folder);
        let binary = self
            .bin
            .join(VERSIONS_FOLDER)
            .join(folder)
            .join(version)
            .join(BINARY_FILE);

        (!channel.is_empty() && !version.is_empty() && is_executable(&binary)).then(|| {
            ActiveVersion {
                channel: channel.to_owned(),
                version: version.to_owned(),
            }
        })
    }

    #[must_use]
    pub fn has_launcher(&self) -> bool {
        is_executable(&self.bin.join(LAUNCHER_FILE))
    }

    #[must_use]
    pub fn current(&self) -> Option<String> {
        let text = fs::read_to_string(self.bin.join(CURRENT_FILE)).ok()?;

        text.trim()
            .rsplit('/')
            .next()
            .filter(|version| !version.is_empty())
            .map(str::to_owned)
    }

    #[must_use]
    pub fn unstable_versions(&self) -> Vec<String> {
        let mut versions: Vec<Version> = Channel::ALL
            .into_iter()
            .filter(|channel| channel.is_unstable())
            .flat_map(|channel| {
                installed_versions(&self.bin.join(VERSIONS_FOLDER).join(channel.folder()))
            })
            .collect();
        versions.sort();

        versions.iter().map(Version::to_string).collect()
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .fold(String::new(), |mut out, byte| {
            let _written = write!(out, "{byte:02x}");
            out
        })
}

fn answered_version(binary: &Path) -> Option<String> {
    let output = Command::new(binary)
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    let text = String::from_utf8_lossy(&output.stdout);
    let version = text.trim().strip_prefix(VERSION_PREFIX)?;

    Version::parse(version)
        .ok()
        .map(|parsed| parsed.to_string())
}

fn verified_as(target: &Path, hash: &str) -> bool {
    fs::read_to_string(target.join(VERIFIED_FILE)).is_ok_and(|text| text.trim() == hash)
        && target.join(BINARY_FILE).is_file()
}

fn replace_dir(staged: &Path, target: &Path) -> io::Result<()> {
    if target.exists() {
        let aside = tempfile::Builder::new()
            .prefix(".replaced-")
            .tempdir_in(target.parent().unwrap_or(target))?
            .keep();
        fs::remove_dir(&aside)?;
        fs::rename(target, &aside)?;
        fs::rename(staged, target)?;
        return fs::remove_dir_all(&aside);
    }

    fs::rename(staged, target)
}

fn receipt(origin: Origin, version: &str, channel: Channel) -> String {
    let fields = Map::from_iter([
        ("origin".to_owned(), Value::from(origin.name())),
        ("version".to_owned(), Value::from(version)),
        ("channel".to_owned(), Value::from(channel.name())),
    ]);

    format!("{}\n", stringify_pretty(&Value::Object(fields)))
}

fn write_if_changed(path: &Path, contents: &str, mode: u32) -> io::Result<()> {
    if fs::read_to_string(path).is_ok_and(|current| current == contents) {
        return Ok(());
    }

    write_file(path, contents.as_bytes(), mode)
}

fn write_file(path: &Path, contents: &[u8], mode: u32) -> io::Result<()> {
    let folder = path.parent().unwrap_or(path);
    let mut temporary = tempfile::Builder::new()
        .prefix(".bcct-")
        .tempfile_in(folder)?;

    temporary.write_all(contents)?;
    temporary.as_file().sync_all()?;
    set_mode(temporary.path(), mode)?;
    temporary.persist(path).map_err(|error| error.error)?;

    Ok(())
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}

fn installed_versions(channel_dir: &Path) -> Vec<Version> {
    fs::read_dir(channel_dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| Version::parse(&entry.file_name().to_string_lossy()).ok())
        .collect()
}

fn prune(channel_dir: &Path, active: &str) -> io::Result<()> {
    let mut versions = installed_versions(channel_dir);
    versions.sort();

    let mut excess = versions.len().saturating_sub(KEPT_PER_FOLDER);

    for version in versions {
        if excess == 0 {
            break;
        }

        let name = version.to_string();

        if name != active {
            fs::remove_dir_all(channel_dir.join(name))?;
            excess -= 1;
        }
    }

    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
struct Request {
    file: PathBuf,
    sha256: String,
    origin: Origin,
}

fn parse_request(args: &[OsString]) -> Option<Request> {
    let mut file = None;
    let mut sha256 = None;
    let mut origin = Origin::Manual;
    let mut words = args.iter().map(|arg| arg.to_str());

    while let Some(word) = words.next() {
        match word? {
            "--sha256" => sha256 = Some(words.next()??.to_owned()),
            "--from" => origin = Origin::parse(words.next()??)?,
            flag if flag.starts_with("--") => return None,
            path if file.is_none() => file = Some(PathBuf::from(path)),
            _ => return None,
        }
    }

    Some(Request {
        file: file?,
        sha256: sha256?,
        origin,
    })
}

pub fn run_process<O: Write, E: Write>(args: &[OsString], stdout: &mut O, stderr: &mut E) -> u8 {
    let paths = Paths::from_process();
    let messages = messages_for(setup_locale(&paths.app_dir, &|name| std::env::var_os(name)));

    run(args, &paths.app_dir, messages, stdout, stderr)
}

fn run<O: Write, E: Write>(
    args: &[OsString],
    app_dir: &Path,
    messages: &Messages,
    stdout: &mut O,
    stderr: &mut E,
) -> u8 {
    let Some(request) = parse_request(args) else {
        let _shown = writeln!(stderr, "{}", messages.self_install_usage);
        return USAGE;
    };

    match Store::new(app_dir).install(&request.file, &request.sha256, request.origin) {
        Ok(installed) => {
            let _shown = writeln!(
                stdout,
                "{}",
                (messages.self_install_done)(&installed.version, installed.channel.name())
            );

            if installed.channel.is_unstable() {
                let _warned = writeln!(
                    stdout,
                    "{}",
                    (messages.self_install_unstable)(installed.channel.name())
                );
            }

            SUCCESS
        }
        Err(failure) => {
            let text = match failure {
                InstallError::HashMismatch => messages.self_install_hash_mismatch,
                InstallError::NotBcct => messages.self_install_not_bcct,
                InstallError::Io(_) => messages.self_install_failed,
            };
            let _shown = writeln!(stderr, "{text}");

            FAILURE
        }
    }
}
