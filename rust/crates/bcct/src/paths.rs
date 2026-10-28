use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub const CONFIG_FILE: &str = "better-cc-telegram.json";
pub const HEALTH_FILE: &str = "health.json";
pub const LAUNCH_FILE: &str = "launch.json";
pub const PREVIOUS_STATUSLINE_FILE: &str = "statusline-previous.json";
pub const APP_FOLDER: &str = "better-claude-code-telegram";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    pub claude_dir: PathBuf,
    pub app_dir: PathBuf,
    pub telegram_state_dir: PathBuf,
}

impl Paths {
    #[must_use]
    pub fn resolve(var: impl Fn(&str) -> Option<OsString>, home: &Path) -> Self {
        let claude_dir =
            non_empty(var("CLAUDE_CONFIG_DIR")).map_or_else(|| home.join(".claude"), PathBuf::from);
        let app_dir = non_empty(var("BETTER_CC_TELEGRAM_DIR"))
            .map_or_else(|| claude_dir.join(APP_FOLDER), PathBuf::from);
        let telegram_state_dir = non_empty(var("TELEGRAM_STATE_DIR")).map_or_else(
            || claude_dir.join("channels").join("telegram"),
            PathBuf::from,
        );

        Self {
            claude_dir,
            app_dir,
            telegram_state_dir,
        }
    }

    #[must_use]
    pub fn from_process() -> Self {
        Self::resolve(
            |name| std::env::var_os(name),
            &std::env::home_dir().unwrap_or_default(),
        )
    }
}

fn non_empty(value: Option<OsString>) -> Option<OsString> {
    value.filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn resolve(vars: &[(&str, &str)]) -> Paths {
        let vars: HashMap<String, OsString> = vars
            .iter()
            .map(|(name, value)| ((*name).to_owned(), OsString::from(value)))
            .collect();

        Paths::resolve(|name| vars.get(name).cloned(), Path::new("/home/user"))
    }

    #[test]
    fn falls_back_to_the_claude_folder_in_the_home_when_nothing_is_set() {
        assert_eq!(
            resolve(&[]),
            Paths {
                claude_dir: PathBuf::from("/home/user/.claude"),
                app_dir: PathBuf::from("/home/user/.claude/better-claude-code-telegram"),
                telegram_state_dir: PathBuf::from("/home/user/.claude/channels/telegram"),
            }
        );
    }

    #[test]
    fn follows_claude_config_dir_for_both_folders() {
        let paths = resolve(&[("CLAUDE_CONFIG_DIR", "/cfg")]);

        assert_eq!(paths.claude_dir, PathBuf::from("/cfg"));
        assert_eq!(
            paths.app_dir,
            PathBuf::from("/cfg/better-claude-code-telegram")
        );
        assert_eq!(
            paths.telegram_state_dir,
            PathBuf::from("/cfg/channels/telegram")
        );
    }

    #[test]
    fn the_explicit_folder_variables_win_over_claude_config_dir() {
        let paths = resolve(&[
            ("CLAUDE_CONFIG_DIR", "/cfg"),
            ("BETTER_CC_TELEGRAM_DIR", "/app"),
            ("TELEGRAM_STATE_DIR", "/state"),
        ]);

        assert_eq!(paths.app_dir, PathBuf::from("/app"));
        assert_eq!(paths.telegram_state_dir, PathBuf::from("/state"));
    }

    #[test]
    fn an_empty_variable_counts_as_unset_like_the_js_or() {
        let paths = resolve(&[
            ("CLAUDE_CONFIG_DIR", ""),
            ("BETTER_CC_TELEGRAM_DIR", ""),
            ("TELEGRAM_STATE_DIR", ""),
        ]);

        assert_eq!(paths, resolve(&[]));
    }

    #[test]
    fn the_process_paths_read_the_real_environment_and_home() {
        let home = std::env::home_dir().unwrap_or_default();

        assert_eq!(
            Paths::from_process(),
            Paths::resolve(|name| std::env::var_os(name), &home)
        );
    }
}
