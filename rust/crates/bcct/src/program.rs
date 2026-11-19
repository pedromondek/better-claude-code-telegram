use std::ffi::OsStr;
use std::path::{Path, PathBuf};

pub const PATH_EXTENSIONS_VARIABLE: &str = "PATHEXT";
const DEFAULT_PATH_EXTENSIONS: &str = ".COM;.EXE;.BAT;.CMD";
const EXTENSION_SEPARATOR: char = ';';

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgramLookup {
    Shell,
    PathSearch,
}

pub const HOST_PROGRAM_LOOKUP: ProgramLookup = if cfg!(windows) {
    ProgramLookup::PathSearch
} else {
    ProgramLookup::Shell
};

fn extensions_of(path_extensions: Option<&OsStr>) -> Vec<String> {
    let listed = path_extensions
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_PATH_EXTENSIONS.to_owned());

    listed
        .split(EXTENSION_SEPARATOR)
        .map(str::trim)
        .filter(|extension| !extension.is_empty())
        .map(str::to_owned)
        .collect()
}

fn names_to_try(name: &str, extensions: &[String]) -> Vec<String> {
    let lower = name.to_ascii_lowercase();
    let already_listed = extensions
        .iter()
        .any(|extension| lower.ends_with(&extension.to_ascii_lowercase()));

    if already_listed {
        return vec![name.to_owned()];
    }

    extensions
        .iter()
        .map(|extension| format!("{name}{extension}"))
        .collect()
}

#[must_use]
pub fn find_program(
    name: &str,
    folders: &[PathBuf],
    path_extensions: Option<&OsStr>,
    is_file: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if name.is_empty() || name.contains(['/', '\\']) {
        return None;
    }

    let names = names_to_try(name, &extensions_of(path_extensions));

    folders
        .iter()
        .filter(|folder| !folder.as_os_str().is_empty())
        .flat_map(|folder| names.iter().map(move |candidate| folder.join(candidate)))
        .find(|candidate| is_file(candidate))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::ffi::OsString;

    fn like_ntfs(path: &str) -> String {
        path.replace('\\', "/").to_lowercase()
    }

    fn existing(files: &[&str]) -> impl Fn(&Path) -> bool {
        let files: BTreeSet<String> = files.iter().map(|file| like_ntfs(file)).collect();

        move |path: &Path| files.contains(&like_ntfs(&path.to_string_lossy()))
    }

    fn folders(names: &[&str]) -> Vec<PathBuf> {
        names.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn finds_the_program_in_the_first_folder_that_has_it() {
        let is_file = existing(&["/b/npm.cmd", "/c/npm.exe"]);

        assert_eq!(
            find_program("npm", &folders(&["/a", "/b", "/c"]), None, &is_file),
            Some(PathBuf::from("/b/npm.CMD"))
        );
    }

    #[test]
    fn tries_the_extensions_in_the_order_of_pathext() {
        let is_file = existing(&["/a/claude.cmd", "/a/claude.exe"]);
        let path = folders(&["/a"]);

        assert_eq!(
            find_program("claude", &path, None, &is_file),
            Some(PathBuf::from("/a/claude.EXE"))
        );
        assert_eq!(
            find_program(
                "claude",
                &path,
                Some(&OsString::from(".CMD;.EXE")),
                &is_file
            ),
            Some(PathBuf::from("/a/claude.CMD"))
        );
    }

    #[test]
    fn keeps_a_name_that_already_ends_in_a_listed_extension() {
        let is_file = existing(&["/a/npm.cmd", "/a/npm.cmd.exe"]);
        let path = folders(&["/a"]);

        assert_eq!(
            find_program("npm.cmd", &path, None, &is_file),
            Some(PathBuf::from("/a/npm.cmd"))
        );
        assert_eq!(
            find_program("npm.CMD", &path, None, &existing(&["/a/npm.CMD"])),
            Some(PathBuf::from("/a/npm.CMD"))
        );
    }

    #[test]
    fn falls_back_to_the_default_extensions_without_pathext() {
        let is_file = existing(&["/a/git.exe"]);
        let path = folders(&["/a"]);

        assert_eq!(
            find_program("git", &path, Some(&OsString::from("  ")), &is_file),
            Some(PathBuf::from("/a/git.EXE"))
        );
        assert_eq!(
            find_program("git", &path, Some(&OsString::from(";;.EXE;")), &is_file),
            Some(PathBuf::from("/a/git.EXE"))
        );
    }

    #[test]
    fn finds_nothing_for_a_missing_program_an_empty_name_or_a_path() {
        let is_file = existing(&["/a/uv.exe", "uv.exe"]);
        let path = folders(&["", "/a"]);

        assert_eq!(find_program("bun", &path, None, &is_file), None);
        assert_eq!(find_program("", &path, None, &is_file), None);
        assert_eq!(find_program("a/uv", &path, None, &is_file), None);
        assert_eq!(find_program("a\\uv", &path, None, &is_file), None);
        assert_eq!(
            find_program("uv", &path, None, &is_file),
            Some(PathBuf::from("/a/uv.EXE"))
        );
    }
}
