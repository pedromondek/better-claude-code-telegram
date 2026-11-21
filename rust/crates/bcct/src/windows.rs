use std::io;

use crate::user_path::{USER_PATH_VARIABLE, UserPath};

#[derive(Debug, Clone, Copy, Default)]
pub struct RegistryUserPath;

impl UserPath for RegistryUserPath {
    fn read(&self) -> io::Result<Option<String>> {
        windows_env::get(USER_PATH_VARIABLE).map_err(io::Error::other)
    }

    fn write(&self, value: &str) -> io::Result<()> {
        windows_env::set_expand_string(USER_PATH_VARIABLE, value).map_err(io::Error::other)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_user_path_of_the_registry() {
        assert!(RegistryUserPath.read().is_ok());
    }
}
