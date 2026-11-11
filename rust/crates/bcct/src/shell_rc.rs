use std::fs;
use std::path::{Path, PathBuf};

use crate::files::FileFailure;
use crate::journal::Journal;
use crate::js::join_path;
use crate::settings::not_saved;
use crate::setup::{read_text, shell_rc_files};
use crate::setup_files::{ConfigError, Printer};

pub const SHELL_MARKER: &str = "# Added by better-claude-code-telegram setup";

const REMOVED_FROM: [&str; 3] = [".bashrc", ".zshrc", ".bash_profile"];
const CLONE_SHELL_SCRIPT: &str = "/scripts/shell.sh";
const CLONE_LINE_START: &str = "[ -f \"";
const CLONE_LINE_MIDDLE: &str = "\" ] && . \"";

#[must_use]
pub fn source_line(shell_file: &str) -> String {
    format!("{CLONE_LINE_START}{shell_file}{CLONE_LINE_MIDDLE}{shell_file}\"")
}

#[must_use]
pub fn rc_loads(rc_text: &str, shell_file: &str) -> bool {
    rc_text.contains(shell_file)
}

fn block(line: &str) -> String {
    format!("{SHELL_MARKER}\n{line}\n")
}

fn is_clone_line(line: &str) -> bool {
    line.strip_prefix(CLONE_LINE_START)
        .and_then(|rest| rest.split_once(CLONE_LINE_MIDDLE))
        .is_some_and(|(tested, loaded)| {
            loaded.strip_suffix('"') == Some(tested)
                && tested.len() > CLONE_SHELL_SCRIPT.len()
                && !tested.contains('"')
                && tested.ends_with(CLONE_SHELL_SCRIPT)
        })
}

fn clone_line(rc_text: &str) -> Option<&str> {
    rc_text.split('\n').find(|line| is_clone_line(line))
}

#[must_use]
pub fn with_shell_block(rc_text: &str, shell_file: &str) -> Option<String> {
    if rc_loads(rc_text, shell_file) {
        return None;
    }

    let line = source_line(shell_file);

    if clone_line(rc_text).is_some() {
        return Some(
            rc_text
                .split('\n')
                .map(|old| {
                    if is_clone_line(old) {
                        line.as_str()
                    } else {
                        old
                    }
                })
                .collect::<Vec<_>>()
                .join("\n"),
        );
    }

    let block = block(&line);

    if rc_text.is_empty() {
        return Some(block);
    }

    let newline = if rc_text.ends_with('\n') { "" } else { "\n" };

    Some(format!("{rc_text}{newline}\n{block}"))
}

fn without_block(rc_text: &str, line: &str) -> String {
    let block = block(line);

    rc_text
        .replacen(&format!("\n\n{block}"), "\n", 1)
        .replacen(&block, "", 1)
}

#[must_use]
pub fn without_shell_block(rc_text: &str, shell_file: &str) -> Option<String> {
    let clone = clone_line(rc_text);

    if !rc_loads(rc_text, shell_file) && clone.is_none() {
        return None;
    }

    let mut text = without_block(rc_text, &source_line(shell_file));

    if let Some(line) = clone {
        text = without_block(&text, line);
    }

    Some(
        text.split('\n')
            .filter(|line| !line.contains(shell_file) && !is_clone_line(line))
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn rc_files(home: &str, shell: Option<&str>, macos: bool) -> (Vec<PathBuf>, Option<String>) {
    let files = shell_rc_files(home, shell, macos);

    (
        files.primary.into_iter().chain(files.others).collect(),
        files.unsupported,
    )
}

#[must_use]
pub fn rc_files_without_shell_line(
    home: &str,
    shell: Option<&str>,
    macos: bool,
    shell_file: &Path,
) -> Vec<PathBuf> {
    let shell_file = shell_file.to_string_lossy();

    rc_files(home, shell, macos)
        .0
        .into_iter()
        .filter(|rc| with_shell_block(&read_text(rc).unwrap_or_default(), &shell_file).is_some())
        .collect()
}

fn write_rc(rc: &Path, text: &str) -> Result<(), FileFailure> {
    fs::write(rc, text).map_err(not_saved(rc))
}

pub fn install_shell_function(
    home: &str,
    shell: Option<&str>,
    macos: bool,
    shell_file: &Path,
    journal: &mut Journal,
    printer: &mut Printer<'_>,
) -> Result<(), ConfigError> {
    let messages = printer.messages;
    let shell_file = shell_file.to_string_lossy();
    let (files, unsupported) = rc_files(home, shell, macos);

    if let Some(name) = unsupported {
        printer.warn(&(messages.shell_unsupported)(
            &name,
            &source_line(&shell_file),
        ));
    }

    for rc in files {
        let rc_name = rc.to_string_lossy();
        let Some(updated) = with_shell_block(&read_text(&rc).unwrap_or_default(), &shell_file)
        else {
            printer.skipped(&(messages.rc_already_loads)(&rc_name));
            continue;
        };

        journal.track_file(&rc).map_err(not_saved(&rc))?;
        write_rc(&rc, &updated)?;
        printer.success(&(messages.rc_now_loads)(&rc_name));
    }

    Ok(())
}

pub fn remove_shell_lines(
    home: &str,
    shell_file: &Path,
    printer: &mut Printer<'_>,
) -> Result<(), ConfigError> {
    let messages = printer.messages;
    let shell_file = shell_file.to_string_lossy();

    for name in REMOVED_FROM {
        let rc = join_path(Path::new(home), name);
        let Some(updated) = without_shell_block(&read_text(&rc).unwrap_or_default(), &shell_file)
        else {
            continue;
        };

        write_rc(&rc, &updated)?;
        printer.success(&(messages.rc_no_longer_loads)(&rc.to_string_lossy()));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEW: &str = "/h/.claude/better-claude-code-telegram/shell.sh";
    const CLONE: &str = "[ -f \"/r/scripts/shell.sh\" ] && . \"/r/scripts/shell.sh\"";

    fn new_line() -> String {
        source_line(NEW)
    }

    #[test]
    fn the_setup_swaps_the_line_of_the_clone_for_the_new_one_in_place() {
        let rc = format!("a\n\n{SHELL_MARKER}\n{CLONE}\nb\n");

        assert_eq!(
            with_shell_block(&rc, NEW),
            Some(format!("a\n\n{SHELL_MARKER}\n{}\nb\n", new_line()))
        );
        assert_eq!(
            with_shell_block(&format!("{CLONE}\n{CLONE}"), NEW),
            Some(format!("{}\n{}", new_line(), new_line()))
        );
    }

    #[test]
    fn the_uninstall_removes_the_block_of_the_clone() {
        assert_eq!(
            without_shell_block(&format!("a\n\n{SHELL_MARKER}\n{CLONE}\nb\n"), NEW),
            Some("a\nb\n".to_owned())
        );
        assert_eq!(
            without_shell_block(&format!("{SHELL_MARKER}\n{CLONE}\nb"), NEW),
            Some("b".to_owned())
        );
        assert_eq!(
            without_shell_block(&format!("a\n{CLONE}\nb"), NEW),
            Some("a\nb".to_owned())
        );
        assert_eq!(
            without_shell_block(
                &format!("a\n\n{SHELL_MARKER}\n{}\n{CLONE}\n", new_line()),
                NEW
            ),
            Some("a\n".to_owned())
        );
    }

    #[test]
    fn only_the_exact_line_of_the_clone_is_taken_as_ours() {
        for line in [
            "[ -f \"/r/scripts/shell.sh\" ] && . \"/s/scripts/shell.sh\"",
            "[ -f \"/r/scripts/other.sh\" ] && . \"/r/scripts/other.sh\"",
            "[ -f \"/scripts/shell.sh\" ] && . \"/scripts/shell.sh\"",
            "[ -f \"/r\"/scripts/shell.sh\" ] && . \"/r\"/scripts/shell.sh\"",
            "[ -f \"/r/scripts/shell.sh\" ] && . \"/r/scripts/shell.sh\" x",
            " [ -f \"/r/scripts/shell.sh\" ] && . \"/r/scripts/shell.sh\"",
            "[ -f \"/r/scripts/shell.sh\" ] || . \"/r/scripts/shell.sh\"",
        ] {
            assert!(!is_clone_line(line), "{line}");
            assert_eq!(without_shell_block(line, NEW), None, "{line}");
        }

        assert!(is_clone_line(CLONE));
    }
}
