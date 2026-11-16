#[macro_export]
macro_rules! npm_package {
    () => {
        "@pedromondek/better-claude-code-telegram"
    };
}

#[macro_export]
macro_rules! setup_command {
    () => {
        concat!("npx ", $crate::npm_package!())
    };
}

#[macro_export]
macro_rules! repository_url {
    () => {
        "https://github.com/pedromondek/better-claude-code-telegram"
    };
}

pub const NPM_PACKAGE: &str = crate::npm_package!();
pub const SETUP_COMMAND: &str = crate::setup_command!();
pub const REPOSITORY_URL: &str = crate::repository_url!();

#[cfg(test)]
mod tests {
    use super::{NPM_PACKAGE, REPOSITORY_URL, SETUP_COMMAND};

    #[test]
    fn the_repository_url_is_the_one_in_the_root_package_json() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../package.json");
        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let url = manifest["repository"]["url"].as_str().unwrap();

        assert_eq!(
            url.trim_start_matches("git+").trim_end_matches(".git"),
            REPOSITORY_URL
        );
    }

    #[test]
    fn the_npm_package_is_the_name_in_the_root_package_json() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../package.json");
        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();

        assert_eq!(manifest["name"], NPM_PACKAGE);
    }

    #[test]
    fn the_setup_command_runs_the_package_through_npx() {
        assert_eq!(SETUP_COMMAND, format!("npx {NPM_PACKAGE}"));
    }
}
