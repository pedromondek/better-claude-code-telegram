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

#[must_use]
pub fn source_line(shell_file: &str) -> String {
    format!("[ -f \"{shell_file}\" ] && . \"{shell_file}\"")
}

#[must_use]
pub fn rc_loads(rc_text: &str, shell_file: &str) -> bool {
    rc_text.contains(shell_file)
}

#[must_use]
pub fn rc_line_active(rc_text: &str, shell_file: &str) -> bool {
    rc_text
        .split('\n')
        .any(|line| line.contains(shell_file) && !line.trim_start().starts_with('#'))
}

fn block(line: &str) -> String {
    format!("{SHELL_MARKER}\n{line}\n")
}

#[must_use]
pub fn with_shell_block(rc_text: &str, shell_file: &str) -> Option<String> {
    if rc_line_active(rc_text, shell_file) {
        return None;
    }

    let block = block(&source_line(shell_file));

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
    if !rc_loads(rc_text, shell_file) {
        return None;
    }

    Some(
        without_block(rc_text, &source_line(shell_file))
            .split('\n')
            .filter(|line| !line.contains(shell_file))
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
    fn new_line() -> String {
        source_line(NEW)
    }

    #[test]
    fn loads_the_shell_file_only_when_it_exists() {
        assert_eq!(
            new_line(),
            "[ -f \"/h/.claude/better-claude-code-telegram/shell.sh\" ] && . \"/h/.claude/better-claude-code-telegram/shell.sh\""
        );
    }

    #[test]
    fn appends_the_block_to_an_empty_rc_and_after_a_last_line_without_newline() {
        assert_eq!(
            with_shell_block("", NEW),
            Some(format!("{SHELL_MARKER}\n{}\n", new_line()))
        );
        assert_eq!(
            with_shell_block("export A=1", NEW),
            Some(format!("export A=1\n\n{SHELL_MARKER}\n{}\n", new_line()))
        );
    }

    #[test]
    fn appends_the_block_when_the_line_of_the_shell_file_is_commented_out() {
        let commented = format!("export A=1\n# {}\n", new_line());

        assert_eq!(
            with_shell_block(&commented, NEW),
            Some(format!("{commented}\n{SHELL_MARKER}\n{}\n", new_line()))
        );
        assert_eq!(
            with_shell_block(&format!("  #{}", new_line()), NEW),
            Some(format!(
                "  #{}\n\n{SHELL_MARKER}\n{}\n",
                new_line(),
                new_line()
            ))
        );
        assert_eq!(
            with_shell_block(&format!("# old\n  {}\n", new_line()), NEW),
            None
        );
        assert_eq!(
            with_shell_block(&format!("{}\n# {NEW}", new_line()), NEW),
            None
        );
    }

    #[test]
    fn the_uninstall_removes_the_block_and_every_line_that_loads_the_shell_file() {
        assert_eq!(
            without_shell_block(&format!("a\n\n{SHELL_MARKER}\n{}\nb\n", new_line()), NEW),
            Some("a\nb\n".to_owned())
        );
        assert_eq!(
            without_shell_block(&format!("{SHELL_MARKER}\n{}\nb", new_line()), NEW),
            Some("b".to_owned())
        );
        assert_eq!(
            without_shell_block(&format!("a\n# {NEW}\nb"), NEW),
            Some("a\nb".to_owned())
        );
        assert_eq!(without_shell_block("a\nb", NEW), None);
    }
}
