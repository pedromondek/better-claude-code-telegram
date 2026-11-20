use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use crate::js::join_path;

#[macro_export]
macro_rules! chromium_install_command {
    () => {
        "npx playwright install chromium"
    };
}

pub const CHROMIUM_INSTALL_COMMAND: &str = crate::chromium_install_command!();

const PLAYWRIGHT_FOLDER: &str = "ms-playwright";
const CHROMIUM_PREFIX: &str = "chromium-";
const NODE_MODULES_INSTALL: &str = "0";
const APP_SUFFIX: &str = ".app";

pub type ListDir<'a> = &'a dyn Fn(&Path) -> Option<Vec<String>>;
pub type Var<'a> = &'a dyn Fn(&str) -> Option<OsString>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Linux,
    Darwin,
    Win32,
}

impl Platform {
    #[must_use]
    pub const fn current() -> Self {
        #[cfg(target_os = "macos")]
        {
            Self::Darwin
        }
        #[cfg(windows)]
        {
            Self::Win32
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            Self::Linux
        }
    }

    const fn folder_prefix(self) -> &'static str {
        match self {
            Self::Linux => "chrome-linux",
            Self::Darwin => "chrome-mac",
            Self::Win32 => "chrome-win",
        }
    }
}

fn filled(var: Var<'_>, name: &str) -> Option<PathBuf> {
    var(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn system_cache_dir(platform: Platform, home: &Path, var: Var<'_>) -> PathBuf {
    match platform {
        Platform::Darwin => join_path(home, "Library/Caches"),
        Platform::Win32 => {
            filled(var, "LOCALAPPDATA").unwrap_or_else(|| join_path(home, "AppData/Local"))
        }
        Platform::Linux => {
            filled(var, "XDG_CACHE_HOME").unwrap_or_else(|| join_path(home, ".cache"))
        }
    }
}

#[must_use]
pub fn playwright_cache_dir(platform: Platform, home: &Path, var: Var<'_>) -> PathBuf {
    filled(var, "PLAYWRIGHT_BROWSERS_PATH")
        .filter(|path| path.as_os_str() != NODE_MODULES_INSTALL)
        .unwrap_or_else(|| join_path(&system_cache_dir(platform, home, var), PLAYWRIGHT_FOLDER))
}

#[must_use]
pub fn read_dir_names(dir: &Path) -> Option<Vec<String>> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .collect();

    names.sort();

    Some(names)
}

fn names_in(list_dir: ListDir<'_>, dir: &Path, matches: impl Fn(&str) -> bool) -> Vec<String> {
    list_dir(dir)
        .unwrap_or_default()
        .into_iter()
        .filter(|name| matches(name))
        .collect()
}

fn chromium_version(name: &str) -> Option<f64> {
    let digits = name.strip_prefix(CHROMIUM_PREFIX)?;

    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }

    digits.parse().ok()
}

fn executable_in(
    platform_dir: &Path,
    platform: Platform,
    list_dir: ListDir<'_>,
) -> Option<PathBuf> {
    match platform {
        Platform::Win32 => Some(join_path(platform_dir, "chrome.exe")),
        Platform::Linux => Some(join_path(platform_dir, "chrome")),
        Platform::Darwin => {
            let apps = names_in(list_dir, platform_dir, |name| name.ends_with(APP_SUFFIX));
            let app = apps.first()?;
            let binary = app.strip_suffix(APP_SUFFIX).unwrap_or(app);

            Some(join_path(
                &join_path(&join_path(platform_dir, app), "Contents/MacOS"),
                binary,
            ))
        }
    }
}

#[must_use]
pub fn find_playwright_chromium(
    cache_dir: &Path,
    platform: Platform,
    list_dir: ListDir<'_>,
) -> Option<PathBuf> {
    let mut versions: Vec<(String, f64)> = names_in(list_dir, cache_dir, |_| true)
        .into_iter()
        .filter_map(|name| chromium_version(&name).map(|version| (name, version)))
        .collect();

    versions.sort_by(|first, second| second.1.total_cmp(&first.1));

    versions.into_iter().find_map(|(name, _)| {
        let version_dir = join_path(cache_dir, &name);
        let platform_folder = names_in(list_dir, &version_dir, |folder| {
            folder.starts_with(platform.folder_prefix())
        })
        .into_iter()
        .next()?;

        executable_in(
            &join_path(&version_dir, &platform_folder),
            platform,
            list_dir,
        )
    })
}

#[must_use]
pub fn playwright_chromium(
    platform: Platform,
    home: &Path,
    var: Var<'_>,
    list_dir: ListDir<'_>,
) -> Option<PathBuf> {
    find_playwright_chromium(
        &playwright_cache_dir(platform, home, var),
        platform,
        list_dir,
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::Value;

    use super::*;

    const FIXTURE: &str = include_str!(
        "../../../../plugins/telegram/extensions/__tests__/fixtures/playwright-chromium.json"
    );

    fn platform_of(name: &str) -> Platform {
        match name {
            "darwin" => Platform::Darwin,
            "win32" => Platform::Win32,
            _ => Platform::Linux,
        }
    }

    fn slashed(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }

    fn tree_of(case: &Value) -> HashMap<String, Vec<String>> {
        case["tree"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(dir, names)| {
                let names = names
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|name| name.as_str().unwrap().to_owned())
                    .collect();

                (dir.clone(), names)
            })
            .collect()
    }

    fn env_of(case: &Value) -> HashMap<String, String> {
        case["env"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(name, value)| (name.clone(), value.as_str().unwrap().to_owned()))
            .collect()
    }

    #[test]
    fn finds_the_chromium_like_the_channel() {
        let cases: Vec<Value> = serde_json::from_str(FIXTURE).unwrap();

        assert_eq!(cases.len(), 11);

        for case in &cases {
            let name = case["name"].as_str().unwrap();
            let platform = platform_of(case["platform"].as_str().unwrap());
            let home = PathBuf::from(case["home"].as_str().unwrap());
            let tree = tree_of(case);
            let env = env_of(case);
            let var = |key: &str| env.get(key).map(OsString::from);
            let list_dir = |dir: &Path| tree.get(&slashed(dir)).cloned();

            assert_eq!(
                slashed(&playwright_cache_dir(platform, &home, &var)),
                case["expected"]["cacheDir"].as_str().unwrap(),
                "{name}: cache folder"
            );
            assert_eq!(
                playwright_chromium(platform, &home, &var, &list_dir).map(|path| slashed(&path)),
                case["expected"]["chromium"].as_str().map(str::to_owned),
                "{name}: chromium"
            );
        }
    }

    #[test]
    fn reads_only_plain_digits_as_the_chromium_version() {
        assert_eq!(chromium_version("chromium-1243"), Some(1243.0));

        for name in [
            "chromium-",
            "chromium-1e3",
            "chromium-1.5",
            "chromium-inf",
            "chromium-12a",
            "headless-1243",
        ] {
            assert_eq!(chromium_version(name), None, "{name}");
        }
    }

    #[test]
    fn reads_the_names_in_a_folder_sorted() {
        let folder = tempfile::tempdir().unwrap();

        for name in ["b", "a", "c"] {
            fs::write(folder.path().join(name), "").unwrap();
        }

        assert_eq!(
            read_dir_names(folder.path()),
            Some(vec!["a".to_owned(), "b".to_owned(), "c".to_owned()])
        );
        assert_eq!(read_dir_names(&folder.path().join("missing")), None);
    }

    #[test]
    fn finds_the_chromium_on_the_disk() {
        let folder = tempfile::tempdir().unwrap();
        let cache = folder.path().join("cache");

        fs::create_dir_all(cache.join("chromium-1243/chrome-linux64")).unwrap();

        assert_eq!(
            find_playwright_chromium(&cache, Platform::Linux, &read_dir_names),
            Some(cache.join("chromium-1243/chrome-linux64/chrome"))
        );
        assert_eq!(
            find_playwright_chromium(
                &folder.path().join("none"),
                Platform::Linux,
                &read_dir_names
            ),
            None
        );
    }
}
