use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::Path;

use serde_json::{Map, Value};

use crate::js::stringify;
use crate::messages::{Messages, messages_for};
use crate::paths::Paths;
use crate::setup::setup_locale;
use crate::update::UPDATE_COMMAND;

pub const PLUGIN_DIR_ENV: &str = "BETTER_CC_TELEGRAM_PLUGIN_DIR";

const MANIFEST: &str = ".claude-plugin/plugin.json";
const EVENT: &str = "SessionStart";

#[must_use]
pub fn plugin_version(plugin_dir: &Path) -> Option<String> {
    let text = fs::read_to_string(plugin_dir.join(MANIFEST)).ok()?;
    let manifest: Value = serde_json::from_str(&text).ok()?;

    manifest
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

#[must_use]
pub fn notice(plugin: &str, binary: &str, messages: &Messages) -> Option<String> {
    if plugin == binary {
        return None;
    }

    let context = format!(
        "better-claude-code-telegram: plugin {plugin}, binary {binary}. Tell the user and recommend running '{UPDATE_COMMAND}'."
    );
    let specific = Map::from_iter([
        ("hookEventName".to_owned(), Value::from(EVENT)),
        ("additionalContext".to_owned(), Value::from(context)),
    ]);
    let output = Map::from_iter([
        (
            "systemMessage".to_owned(),
            Value::from((messages.session_start_notice)(plugin, binary)),
        ),
        ("hookSpecificOutput".to_owned(), Value::Object(specific)),
    ]);

    Some(stringify(&Value::Object(output)))
}

pub fn run(
    var: &dyn Fn(&str) -> Option<OsString>,
    app_dir: &Path,
    binary: &str,
    stdout: &mut dyn Write,
) {
    let Some(plugin) = var(PLUGIN_DIR_ENV).and_then(|dir| plugin_version(Path::new(&dir))) else {
        return;
    };
    let messages = messages_for(setup_locale(app_dir, var));

    if let Some(output) = notice(&plugin, binary, messages) {
        let _written = stdout
            .write_all(output.as_bytes())
            .and_then(|()| stdout.flush());
    }
}

pub fn run_process(stdout: &mut dyn Write) {
    let paths = Paths::from_process();

    run(
        &|name| std::env::var_os(name),
        &paths.app_dir,
        env!("CARGO_PKG_VERSION"),
        stdout,
    );
}
