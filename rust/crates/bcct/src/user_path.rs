use std::io;

pub const USER_PATH_VARIABLE: &str = "Path";
const LIST_SEPARATOR: char = ';';
const TRAILING_SEPARATORS: [char; 2] = ['\\', '/'];

pub trait UserPath {
    fn read(&self) -> io::Result<Option<String>>;
    fn write(&self, value: &str) -> io::Result<()>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathChange {
    Changed { previous: Option<String> },
    Unchanged,
}

fn comparable(entry: &str) -> String {
    entry
        .trim()
        .trim_end_matches(TRAILING_SEPARATORS)
        .to_ascii_lowercase()
}

fn same_folder(entry: &str, folder: &str) -> bool {
    !entry.trim().is_empty() && comparable(entry) == comparable(folder)
}

#[must_use]
pub fn lists_folder(current: Option<&str>, folder: &str) -> bool {
    current.is_some_and(|value| {
        value
            .split(LIST_SEPARATOR)
            .any(|entry| same_folder(entry, folder))
    })
}

#[must_use]
pub fn with_folder(current: Option<&str>, folder: &str) -> Option<String> {
    if lists_folder(current, folder) {
        return None;
    }

    Some(match current.filter(|value| !value.is_empty()) {
        Some(value) => format!("{folder}{LIST_SEPARATOR}{value}"),
        None => folder.to_owned(),
    })
}

#[must_use]
pub fn without_folder(current: Option<&str>, folder: &str) -> Option<String> {
    let value = current.filter(|value| lists_folder(Some(value), folder))?;
    let kept: Vec<&str> = value
        .split(LIST_SEPARATOR)
        .filter(|entry| !same_folder(entry, folder))
        .collect();

    Some(kept.join(&LIST_SEPARATOR.to_string()))
}

fn apply(
    user_path: &dyn UserPath,
    change: impl FnOnce(Option<&str>) -> Option<String>,
) -> io::Result<PathChange> {
    let previous = user_path.read()?;
    let Some(updated) = change(previous.as_deref()) else {
        return Ok(PathChange::Unchanged);
    };

    user_path.write(&updated)?;
    Ok(PathChange::Changed { previous })
}

pub fn add_folder(user_path: &dyn UserPath, folder: &str) -> io::Result<PathChange> {
    apply(user_path, |current| with_folder(current, folder))
}

pub fn remove_folder(user_path: &dyn UserPath, folder: &str) -> io::Result<PathChange> {
    apply(user_path, |current| without_folder(current, folder))
}

#[cfg(test)]
pub(crate) mod fake {
    use std::cell::RefCell;
    use std::io;

    use super::UserPath;

    #[derive(Debug, Default)]
    pub(crate) struct FakeUserPath {
        pub(crate) value: RefCell<Option<String>>,
        pub(crate) writes: RefCell<Vec<String>>,
        pub(crate) fails_to_read: bool,
        pub(crate) fails_to_write: bool,
    }

    impl FakeUserPath {
        pub(crate) fn holding(value: &str) -> Self {
            Self {
                value: RefCell::new(Some(value.to_owned())),
                ..Self::default()
            }
        }
    }

    impl UserPath for FakeUserPath {
        fn read(&self) -> io::Result<Option<String>> {
            if self.fails_to_read {
                return Err(io::ErrorKind::PermissionDenied.into());
            }

            Ok(self.value.borrow().clone())
        }

        fn write(&self, value: &str) -> io::Result<()> {
            if self.fails_to_write {
                return Err(io::ErrorKind::PermissionDenied.into());
            }

            self.writes.borrow_mut().push(value.to_owned());
            self.value.replace(Some(value.to_owned()));
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeUserPath;
    use super::*;

    const BIN: &str = "C:\\Users\\x\\.claude\\better-claude-code-telegram\\bin";

    #[test]
    fn finds_the_folder_ignoring_case_spaces_and_a_trailing_separator() {
        let listed = "%USERPROFILE%\\.local\\bin; c:\\users\\X\\.claude\\better-claude-code-telegram\\BIN\\ ;C:\\tools";

        assert!(lists_folder(Some(listed), BIN));
        assert!(lists_folder(Some(&format!("{BIN}/")), BIN));
        assert!(!lists_folder(Some("C:\\tools;;C:\\other"), BIN));
        assert!(!lists_folder(Some(""), BIN));
        assert!(!lists_folder(None, BIN));
        assert!(!lists_folder(Some(" ;C:\\tools"), " "));
    }

    #[test]
    fn puts_the_folder_first_and_keeps_the_rest_as_it_was() {
        assert_eq!(
            with_folder(Some("%USERPROFILE%\\.local\\bin;;C:\\tools;"), BIN),
            Some(format!("{BIN};%USERPROFILE%\\.local\\bin;;C:\\tools;"))
        );
        assert_eq!(with_folder(Some(""), BIN), Some(BIN.to_owned()));
        assert_eq!(with_folder(None, BIN), Some(BIN.to_owned()));
        assert_eq!(with_folder(Some(&format!("C:\\a;{BIN}")), BIN), None);
    }

    #[test]
    fn takes_out_every_entry_of_the_folder_and_nothing_else() {
        assert_eq!(
            without_folder(Some(&format!("{BIN};%TEMP%;{BIN}\\;C:\\tools")), BIN),
            Some("%TEMP%;C:\\tools".to_owned())
        );
        assert_eq!(without_folder(Some(BIN), BIN), Some(String::new()));
        assert_eq!(without_folder(Some("C:\\tools"), BIN), None);
        assert_eq!(without_folder(None, BIN), None);
    }

    #[test]
    fn writes_only_when_the_path_changes_and_returns_the_previous_value() {
        let user_path = FakeUserPath::holding("C:\\tools");

        assert_eq!(
            add_folder(&user_path, BIN).unwrap(),
            PathChange::Changed {
                previous: Some("C:\\tools".to_owned())
            }
        );
        assert_eq!(add_folder(&user_path, BIN).unwrap(), PathChange::Unchanged);
        assert_eq!(
            remove_folder(&user_path, BIN).unwrap(),
            PathChange::Changed {
                previous: Some(format!("{BIN};C:\\tools"))
            }
        );
        assert_eq!(
            remove_folder(&user_path, BIN).unwrap(),
            PathChange::Unchanged
        );
        assert_eq!(
            *user_path.writes.borrow(),
            vec![format!("{BIN};C:\\tools"), "C:\\tools".to_owned()]
        );
    }

    #[test]
    fn adds_the_folder_when_the_user_has_no_path_yet() {
        let user_path = FakeUserPath::default();

        assert_eq!(
            add_folder(&user_path, BIN).unwrap(),
            PathChange::Changed { previous: None }
        );
        assert_eq!(*user_path.writes.borrow(), vec![BIN.to_owned()]);
    }

    #[test]
    fn stops_with_the_error_and_writes_nothing_when_the_path_cannot_be_read() {
        let user_path = FakeUserPath {
            fails_to_read: true,
            ..FakeUserPath::default()
        };

        assert!(add_folder(&user_path, BIN).is_err());
        assert!(remove_folder(&user_path, BIN).is_err());
        assert!(user_path.writes.borrow().is_empty());
    }

    #[test]
    fn stops_with_the_error_when_the_path_cannot_be_written() {
        let user_path = FakeUserPath {
            fails_to_write: true,
            ..FakeUserPath::holding("C:\\tools")
        };

        assert_eq!(
            add_folder(&user_path, BIN).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(user_path.value.borrow().as_deref(), Some("C:\\tools"));
    }
}
