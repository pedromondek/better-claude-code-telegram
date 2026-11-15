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

pub const NPM_PACKAGE: &str = crate::npm_package!();
pub const SETUP_COMMAND: &str = crate::setup_command!();

#[cfg(test)]
mod tests {
    use super::{NPM_PACKAGE, SETUP_COMMAND};

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
