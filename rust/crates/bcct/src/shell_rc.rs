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

fn block(shell_file: &str) -> String {
    format!("{SHELL_MARKER}\n{}\n", source_line(shell_file))
}

#[must_use]
pub fn with_shell_block(rc_text: &str, shell_file: &str) -> Option<String> {
    if rc_loads(rc_text, shell_file) {
        return None;
    }

    let block = block(shell_file);

    if rc_text.is_empty() {
        return Some(block);
    }

    let newline = if rc_text.ends_with('\n') { "" } else { "\n" };

    Some(format!("{rc_text}{newline}\n{block}"))
}

#[must_use]
pub fn without_shell_block(rc_text: &str, shell_file: &str) -> Option<String> {
    if !rc_loads(rc_text, shell_file) {
        return None;
    }

    let block = block(shell_file);
    let text = rc_text
        .replacen(&format!("\n\n{block}"), "\n", 1)
        .replacen(&block, "", 1);

    Some(
        text.split('\n')
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
