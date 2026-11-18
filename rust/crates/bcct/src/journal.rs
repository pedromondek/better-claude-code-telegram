use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::messages::Messages;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    FileCreated,
    FileChanged,
    DirCreated,
    MarketplaceAdded,
    PluginInstalled,
    PluginRemoved,
    ToolInstalled,
}

impl ChangeKind {
    #[must_use]
    pub fn describe(self, target: &str, messages: &Messages) -> String {
        let kinds = &messages.change_kinds;
        let describe = match self {
            Self::FileCreated => kinds.file_created,
            Self::FileChanged => kinds.file_changed,
            Self::DirCreated => kinds.dir_created,
            Self::MarketplaceAdded => kinds.marketplace_added,
            Self::PluginInstalled => kinds.plugin_installed,
            Self::PluginRemoved => kinds.plugin_removed,
            Self::ToolInstalled => kinds.tool_installed,
        };

        describe(target)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    pub kind: ChangeKind,
    pub target: String,
}

impl Change {
    #[must_use]
    pub fn describe(&self, messages: &Messages) -> String {
        self.kind.describe(&self.target, messages)
    }
}

pub type UndoAction = Box<dyn FnOnce() -> bool>;

enum Undo {
    Restore {
        path: PathBuf,
        content: Vec<u8>,
        mode: u32,
    },
    RemoveFile(PathBuf),
    RemoveTree(PathBuf),
    Action(UndoAction),
    Nothing,
}

impl Undo {
    fn run(self) -> bool {
        match self {
            Self::Restore {
                path,
                content,
                mode,
            } => restore(&path, &content, mode).is_ok(),
            Self::RemoveFile(path) => ignore_missing(fs::remove_file(path)).is_ok(),
            Self::RemoveTree(path) => remove_tree(&path).is_ok(),
            Self::Action(action) => action(),
            Self::Nothing => false,
        }
    }
}

struct Entry {
    change: Change,
    undo: Undo,
}

#[derive(Default)]
pub struct Journal {
    entries: Vec<Entry>,
    tracked: HashSet<String>,
    originals: HashMap<String, Option<String>>,
}

impl std::fmt::Debug for Journal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Journal")
            .field("changes", &self.changes())
            .finish_non_exhaustive()
    }
}

fn exists(path: &Path) -> bool {
    fs::metadata(path).is_ok()
}

fn ignore_missing(result: io::Result<()>) -> io::Result<()> {
    match result {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn remove_tree(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
    }
}

fn mode_of(metadata: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o777
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        0
    }
}

fn restore(path: &Path, content: &[u8], mode: u32) -> io::Result<()> {
    fs::write(path, content)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = mode;

    Ok(())
}

#[must_use]
pub fn resolved_target(file: &Path) -> PathBuf {
    fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf())
}

#[must_use]
pub fn link_target(file: &Path) -> PathBuf {
    fs::canonicalize(file).unwrap_or_else(|_| {
        fs::read_link(file).map_or_else(
            |_| file.to_path_buf(),
            |target| file.with_file_name("").join(target),
        )
    })
}

impl Journal {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&mut self, kind: ChangeKind, target: &str, undo: Option<UndoAction>) {
        self.push(kind, target, undo.map_or(Undo::Nothing, Undo::Action));
    }

    fn push(&mut self, kind: ChangeKind, target: &str, undo: Undo) {
        self.entries.push(Entry {
            change: Change {
                kind,
                target: target.to_owned(),
            },
            undo,
        });
    }

    pub fn track_file(&mut self, file: &Path) -> io::Result<()> {
        let target = resolved_target(file);
        let key = target.to_string_lossy().into_owned();

        if !self.tracked.insert(key.clone()) {
            return Ok(());
        }

        let Ok(metadata) = fs::metadata(&target) else {
            self.originals.insert(key.clone(), None);
            self.push(ChangeKind::FileCreated, &key, Undo::RemoveFile(target));
            return Ok(());
        };
        let content = fs::read(&target)?;

        self.originals.insert(
            key.clone(),
            Some(String::from_utf8_lossy(&content).into_owned()),
        );
        self.push(
            ChangeKind::FileChanged,
            &key,
            Undo::Restore {
                path: target,
                content,
                mode: mode_of(&metadata),
            },
        );

        Ok(())
    }

    pub fn track_dir(&mut self, dir: &Path) {
        if exists(dir) {
            return;
        }

        let top = dir
            .ancestors()
            .take_while(|folder| !folder.as_os_str().is_empty() && !exists(folder))
            .last()
            .unwrap_or(dir)
            .to_path_buf();
        let key = top.to_string_lossy().into_owned();

        if self.tracked.insert(key.clone()) {
            self.push(ChangeKind::DirCreated, &key, Undo::RemoveTree(top));
        }
    }

    #[must_use]
    pub fn original(&self, target: &str) -> Option<Option<&str>> {
        self.originals.get(target).map(Option::as_deref)
    }

    #[must_use]
    pub fn changes(&self) -> Vec<Change> {
        self.entries
            .iter()
            .map(|entry| entry.change.clone())
            .collect()
    }

    pub fn undo_all(
        &mut self,
        on_start: &mut dyn FnMut(&Change),
        on_done: &mut dyn FnMut(&Change, bool),
    ) -> Vec<Change> {
        let mut left = Vec::new();

        while let Some(Entry { change, undo }) = self.entries.pop() {
            on_start(&change);

            let done = undo.run();

            if !done {
                left.push(change.clone());
            }

            on_done(&change, done);
        }

        self.tracked.clear();
        self.originals.clear();

        left
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn quiet(journal: &mut Journal) -> Vec<Change> {
        journal.undo_all(&mut |_| {}, &mut |_, _| {})
    }

    #[test]
    fn starts_empty() {
        let mut journal = Journal::new();

        assert_eq!(journal.changes(), Vec::new());
        assert_eq!(quiet(&mut journal), Vec::new());
        assert!(format!("{journal:?}").starts_with("Journal { changes: []"));
    }

    #[test]
    fn a_relative_folder_climbs_only_to_the_current_one() {
        let mut journal = Journal::new();

        journal.track_dir(Path::new("bcct-missing-folder/inner"));

        assert_eq!(
            journal.changes(),
            vec![Change {
                kind: ChangeKind::DirCreated,
                target: "bcct-missing-folder".to_owned(),
            }]
        );
    }

    #[test]
    fn a_file_that_cannot_be_read_fails_once_and_records_nothing_like_the_js() {
        let folder = tempfile::tempdir().unwrap();
        let mut journal = Journal::new();

        assert!(journal.track_file(folder.path()).is_err());
        assert_eq!(journal.changes(), Vec::new());
        assert!(journal.track_file(folder.path()).is_ok());
        assert_eq!(journal.changes(), Vec::new());
    }

    #[test]
    fn removing_ignores_what_is_gone_like_rm_with_force() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("file");
        fs::write(&file, "x").unwrap();

        assert!(remove_tree(&file.join("inside")).is_ok());
        assert!(remove_tree(&folder.path().join("x".repeat(300))).is_err());
        assert!(remove_tree(&folder.path().join("missing")).is_ok());
        #[cfg(unix)]
        assert!(ignore_missing(fs::remove_file(file.join("inside"))).is_err());
        #[cfg(windows)]
        assert!(ignore_missing(fs::remove_file(file.join("inside"))).is_ok());
        remove_tree(&file).unwrap();
        assert!(!file.exists());
    }

    #[test]
    fn an_undo_action_reports_its_own_result() {
        let mut journal = Journal::new();
        let calls = Rc::new(RefCell::new(Vec::new()));
        let seen = Rc::clone(&calls);

        journal.record(
            ChangeKind::PluginInstalled,
            "a",
            Some(Box::new(move || {
                seen.borrow_mut().push("a");
                true
            })),
        );
        journal.record(ChangeKind::PluginInstalled, "b", Some(Box::new(|| false)));

        let left = quiet(&mut journal);

        assert_eq!(
            left,
            vec![Change {
                kind: ChangeKind::PluginInstalled,
                target: "b".to_owned(),
            }]
        );
        assert_eq!(*calls.borrow(), vec!["a"]);
    }
}
