use std::fs;
use std::io::{self, Write};
use std::path::Path;

use serde_json::Value;

use crate::js::parse_json;

#[cfg(unix)]
const PRIVATE_FILE_MODE: u32 = 0o600;
#[cfg(unix)]
const PRIVATE_DIR_MODE: u32 = 0o700;

#[must_use]
pub fn read_json(path: &Path) -> Option<Value> {
    let bytes = fs::read(path).ok()?;
    parse_json(&String::from_utf8_lossy(&bytes))
}

pub fn create_private_dir(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(PRIVATE_DIR_MODE);
    }

    builder.create(path)
}

pub fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    let folder = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path without a folder"))?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".bcct-")
        .tempfile_in(folder)?;

    temporary.write_all(contents)?;
    temporary.as_file().sync_all()?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(PRIVATE_FILE_MODE))?;
    }

    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_json_file() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("a.json");
        fs::write(&file, r#"{"language":"pt-br"}"#).unwrap();

        assert_eq!(
            read_json(&file),
            Some(serde_json::json!({"language": "pt-br"}))
        );
    }

    #[test]
    fn invalid_utf8_bytes_become_replacement_characters_like_node() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("a.json");
        fs::write(&file, b"{\"note\":\"\xff\"}").unwrap();

        assert_eq!(
            read_json(&file),
            Some(serde_json::json!({"note": "\u{fffd}"}))
        );
    }

    #[test]
    fn a_lone_surrogate_escape_reads_as_the_replacement_character() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("a.json");
        fs::write(&file, r#"{"note":"\ud83d"}"#).unwrap();

        assert_eq!(
            read_json(&file),
            Some(serde_json::json!({"note": "\u{fffd}"}))
        );
    }

    #[test]
    fn a_missing_or_broken_json_file_reads_as_nothing() {
        let folder = tempfile::tempdir().unwrap();
        let broken = folder.path().join("broken.json");
        fs::write(&broken, "{not json").unwrap();

        assert_eq!(read_json(&folder.path().join("missing.json")), None);
        assert_eq!(read_json(&broken), None);
    }

    #[test]
    fn writes_the_whole_content_and_replaces_an_existing_file() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("state.json");
        fs::write(&file, "old content that is longer").unwrap();

        write_private(&file, b"new").unwrap();

        assert_eq!(fs::read_to_string(&file).unwrap(), "new");
    }

    #[test]
    fn leaves_no_temporary_file_behind() {
        let folder = tempfile::tempdir().unwrap();

        write_private(&folder.path().join("state.json"), b"{}").unwrap();

        let names: Vec<_> = fs::read_dir(folder.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("state.json")]);
    }

    #[test]
    fn refuses_a_path_without_a_folder_instead_of_writing_in_the_current_one() {
        let error = write_private(Path::new("/"), b"{}").unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn fails_when_the_folder_does_not_exist() {
        let folder = tempfile::tempdir().unwrap();

        assert!(write_private(&folder.path().join("missing/state.json"), b"{}").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn the_written_file_is_private_even_when_it_replaces_a_public_one() {
        use std::os::unix::fs::PermissionsExt;

        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("state.json");
        fs::write(&file, "x").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();

        write_private(&file, b"{}").unwrap();

        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn creates_nested_private_folders_and_accepts_an_existing_one() {
        use std::os::unix::fs::PermissionsExt;

        let folder = tempfile::tempdir().unwrap();
        let nested = folder.path().join("app/asks");

        create_private_dir(&nested).unwrap();
        create_private_dir(&nested).unwrap();

        assert_eq!(
            fs::metadata(&nested).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}
