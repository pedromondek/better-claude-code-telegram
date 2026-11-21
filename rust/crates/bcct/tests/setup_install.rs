#![cfg(unix)]
#![cfg(test)]

mod support;

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::io::{self, Write};
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::rc::Rc;

use bcct::config::Visuals;
use bcct::health::Screen;
use bcct::install::{
    Asker, ClaudeUndo, CommandsChoice, Declined, Failure, Install, Installed, Installer, Journal,
    Kept, MARKETPLACE_NAME, MERMAID_UNINSTALL_COMMAND, Machine, PLUGIN_IDS, Parsed, PluginChoice,
    System, TRANSCRIPTION_MODELS, Tool, TranscriptionChoice, VenvLayout, VisualsPick,
    declined_report, huggingface_cache_dir, installer_for, installer_in, manual_uninstall_commands,
    parse_inbox_days, parse_transcription_model, plugin_plan, python_env_failed_in, python_program,
    uv_venv_args, venv_layout, whisper_python_in,
};
use bcct::journal::ChangeKind;
use bcct::js::{PathFlavor, format_number};
use bcct::locale::Locale;
use bcct::messages::{Messages, messages_for};
use bcct::setup::git_version_from;
use bcct::spinner::Terminal;
use serde_json::{Value, json};
use support::{
    app_form, default_file_mode, expected_tree, list, marketplace, materialize, parse,
    placeholders, sandbox, snapshot, strings, substitute, text,
};

const FIXTURE: &str = include_str!("fixtures/setup-install.json");

#[derive(Clone, Default)]
struct Shared(Rc<RefCell<Vec<u8>>>);

impl Write for Shared {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.borrow_mut().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Shared {
    fn text(&self) -> String {
        String::from_utf8(self.0.borrow().clone()).unwrap()
    }
}

struct FakeAsker {
    answers: VecDeque<Value>,
    asks: Vec<Value>,
    messages: &'static Messages,
}

impl FakeAsker {
    fn next(&mut self) -> Value {
        self.answers.pop_front().unwrap()
    }
}

fn model(name: &str) -> &'static str {
    TRANSCRIPTION_MODELS
        .into_iter()
        .find(|model| *model == name)
        .unwrap()
}

fn plugin(name: &str) -> &'static str {
    PLUGIN_IDS.into_iter().find(|id| *id == name).unwrap()
}

fn number(value: f64) -> Value {
    serde_json::from_str(&format_number(value)).unwrap()
}

impl Asker for FakeAsker {
    type Error = String;

    fn yes_no(&mut self, prompt: &str, default_yes: bool) -> Result<bool, String> {
        self.asks
            .push(json!({"name": "askYesNo", "prompt": prompt, "defaultYes": default_yes}));
        Ok(self.next().as_bool().unwrap())
    }

    fn installed_commands(&mut self) -> Result<CommandsChoice, String> {
        self.asks.push(json!({"name": "askInstalledCommands"}));
        Ok(if self.next() == json!("keep") {
            CommandsChoice::Keep
        } else {
            CommandsChoice::Remove
        })
    }

    fn transcription(
        &mut self,
        current: Option<&'static str>,
        saved: bool,
        installed: &[&'static str],
    ) -> Result<TranscriptionChoice, String> {
        self.asks.push(json!({
            "name": "askTranscription",
            "current": current,
            "saved": saved,
            "installed": installed,
        }));
        let answer = self.next();

        Ok(match answer {
            Value::Null => TranscriptionChoice::Off,
            Value::String(name) => TranscriptionChoice::Model(model(&name)),
            _ if installed.len() == 1 => TranscriptionChoice::Uninstall(installed.to_vec()),
            _ => {
                let in_use = current.filter(|_| saved);
                let tag = self.messages.model_in_use;

                TranscriptionChoice::Uninstall(self.remove_models(installed, in_use, tag)?)
            }
        })
    }

    fn remove_models(
        &mut self,
        others: &[&'static str],
        previous: Option<&'static str>,
        tag: &str,
    ) -> Result<Vec<&'static str>, String> {
        self.asks.push(json!({
            "name": "askRemoveModels",
            "others": others,
            "previous": previous,
            "tag": tag,
        }));

        let answer = self.next();

        if answer == json!({"stop": true}) {
            return Err("stop".to_owned());
        }

        Ok(strings(&answer).iter().map(|name| model(name)).collect())
    }

    fn inbox(&mut self, current: Option<f64>, saved: bool) -> Result<Option<f64>, String> {
        self.asks.push(json!({
            "name": "askInbox",
            "current": current.map_or(Value::Null, number),
            "saved": saved,
        }));

        Ok(self.next().as_f64())
    }

    fn visuals(
        &mut self,
        _current: Visuals,
        _saved: bool,
        _review_saved: bool,
    ) -> Result<VisualsPick, String> {
        Err("the fixture asks nothing about the visuals".to_owned())
    }
}

fn kind_name(kind: ChangeKind) -> &'static str {
    match kind {
        ChangeKind::ToolInstalled => "toolInstalled",
        ChangeKind::MarketplaceAdded => "marketplaceAdded",
        ChangeKind::PluginInstalled => "pluginInstalled",
        ChangeKind::PluginRemoved => "pluginRemoved",
        ChangeKind::FileCreated
        | ChangeKind::FileChanged
        | ChangeKind::DirCreated
        | ChangeKind::UserPathChanged => {
            panic!("the install step records no file or PATH change")
        }
    }
}

#[derive(Default)]
struct FakeJournal {
    calls: Vec<Value>,
    undos: Vec<String>,
}

impl Journal for FakeJournal {
    fn record(&mut self, kind: ChangeKind, target: String, undo: Option<ClaudeUndo>) {
        self.calls.push(json!({
            "call": "record",
            "kind": kind_name(kind),
            "target": target,
            "undo": undo.is_some(),
        }));
        self.undos.extend(undo.map(|undo| undo.args.join(" ")));
    }

    fn track_dir(&mut self, dir: &Path) {
        self.calls
            .push(json!({"call": "trackDir", "path": dir.to_string_lossy()}));
    }

    fn track_file(&mut self, file: &Path) -> io::Result<()> {
        self.calls
            .push(json!({"call": "trackFile", "path": file.to_string_lossy()}));
        Ok(())
    }
}

fn sys_dir() -> tempfile::TempDir {
    let sys = sandbox();

    for tool in ["sh", "bash"] {
        let found = Command::new("sh")
            .args(["-c", &format!("command -v {tool}")])
            .output()
            .unwrap();
        let found = String::from_utf8(found.stdout).unwrap();

        symlink(found.trim(), sys.path().join(tool)).unwrap();
    }

    sys
}

fn failure_json(failure: Failure<String>) -> Value {
    match failure {
        Failure::Failed(message) => {
            json!({"message": message, "declined": false, "hint": null, "commands": null})
        }
        Failure::Declined(Declined {
            message,
            hint,
            commands,
        }) => json!({"message": message, "declined": true, "hint": hint, "commands": commands}),
        other => panic!("unexpected failure {other:?}"),
    }
}

fn outcome<T>(result: Result<T, Failure<String>>, value: impl Fn(T) -> Value) -> (Value, Value) {
    match result {
        Ok(done) => (value(done), Value::Null),
        Err(failure) => (Value::Null, failure_json(failure)),
    }
}

fn nothing<T>(_: T) -> Value {
    Value::Null
}

fn choice_json(
    PluginChoice {
        marketplaces,
        plugins,
        plugin_ids,
        removed_ids,
    }: PluginChoice,
) -> Value {
    json!({
        "marketplaces": marketplaces,
        "plugins": plugins,
        "pluginIds": plugin_ids,
        "removedIds": removed_ids,
    })
}

fn choice_from(input: &Value) -> PluginChoice {
    let ids = |key: &str| -> Vec<&'static str> {
        strings(&input[key]).iter().map(|id| plugin(id)).collect()
    };

    PluginChoice {
        marketplaces: text(input, "marketplaces").to_owned(),
        plugins: text(input, "plugins").to_owned(),
        plugin_ids: ids("pluginIds"),
        removed_ids: ids("removedIds"),
    }
}

fn kept_from(input: &Value) -> Kept<'_> {
    let value = &input["value"];

    match text(input, "step") {
        "language" => Kept::Language(value.as_str().unwrap()),
        "delay" => Kept::Delay(value.as_f64().unwrap()),
        "quiet-hours" => Kept::QuietHours(value.as_object().map(|range| {
            (
                range["start"].as_str().unwrap(),
                range["end"].as_str().unwrap(),
            )
        })),
        "inbox" => Kept::Inbox(value.as_f64()),
        _ => Kept::Transcription(value.as_str()),
    }
}

struct Run {
    out: String,
    err: String,
    value: Value,
    error: Value,
    path: String,
    asks: Value,
    journal: Value,
    undos: Vec<String>,
}

fn messages_of(scenario: &Value) -> &'static Messages {
    messages_for(Locale::parse(text(scenario, "locale")).unwrap())
}

fn run_op(
    scenario: &Value,
    install: &mut Install<'_, '_, String>,
    app_dir: &Path,
    out: &mut Shared,
) -> (Value, Value) {
    let input = &scenario["input"];

    match text(scenario, "op") {
        "requirements" => {
            let tools: Vec<Tool> = strings(input)
                .iter()
                .map(|tool| Tool::parse(tool).unwrap())
                .collect();
            outcome(install.ensure_requirements(&tools), nothing)
        }
        "pluginCheck" => outcome(install.confirm_plugin_step(), choice_json),
        "pluginEnsure" => outcome(install.ensure_plugins(&choice_from(input)), nothing),
        "transcription" => outcome(install.ensure_transcription(app_dir), nothing),
        "applyTranscription" => outcome(
            install.apply_transcription(app_dir, input.as_str().map(model)),
            nothing,
        ),
        "inbox" => outcome(install.ensure_inbox(app_dir), nothing),
        "kept" => outcome(install.kept_setting(kept_from(input), app_dir), Value::Bool),
        "uninstall" => outcome(
            install
                .remove_plugins()
                .and_then(|()| install.remove_transcription(app_dir))
                .and_then(|()| install.remove_mermaid()),
            nothing,
        ),
        _ => {
            let declined = Declined {
                message: text(input, "message").to_owned(),
                hint: messages_of(scenario).by_hand,
                commands: strings(&input["commands"]),
            };
            out.write_all(
                declined_report(&declined, scenario["colorize"] == json!(true)).as_bytes(),
            )
            .unwrap();
            (Value::Null, Value::Null)
        }
    }
}

fn installer_into(out: Shared, err: Shared) -> impl Fn(&System, &str) -> Option<i32> {
    move |system: &System, command: &str| {
        let output = system
            .command("sh")
            .args(["-c", command])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        out.0.borrow_mut().extend_from_slice(&output.stdout);
        err.0.borrow_mut().extend_from_slice(&output.stderr);
        output.status.code()
    }
}

fn replay(scenario: &Value, root: &Path, sys: &Path) -> Run {
    let fill = |value: &str| substitute(value, root).replace("{sys}", &sys.to_string_lossy());
    let env: HashMap<String, String> = scenario["env"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, value)| (name.clone(), fill(value.as_str().unwrap())))
        .collect();
    let var = |name: &str| env.get(name).map(OsString::from);
    let home = PathBuf::from(&env["HOME"]);
    let hf_cache = huggingface_cache_dir(&var, &home);
    let settings_file = Path::new(&env["CLAUDE_CONFIG_DIR"]).join("settings.json");
    let app_dir = PathBuf::from(&env["BETTER_CC_TELEGRAM_DIR"]);
    let source = marketplace();
    let system = System::new(
        env.iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect(),
    );
    let tty = scenario["tty"].as_u64();
    let mut out = Shared::default();
    let mut err = if tty.is_some() {
        out.clone()
    } else {
        Shared::default()
    };
    let run_installer = installer_into(out.clone(), err.clone());
    let machine = Machine {
        home: &home,
        app_dir: &app_dir,
        marketplace: &source,
        hf_cache: &hf_cache,
        settings_file: &settings_file,
        shell: env.get("SHELL").map(String::as_str),
        macos: false,
        system: &system,
        run_installer: &run_installer,
        chromium: &|| None,
    };
    let colorize = scenario["colorize"] == json!(true);
    let mut out_writer = out.clone();
    let mut screen = Screen {
        out: &mut out_writer,
        err: &mut err,
        terminal: tty.map(|columns| Terminal {
            columns: Some(u16::try_from(columns).unwrap()),
        }),
        colorize_out: colorize,
        colorize_err: colorize,
        spin: &|_, _| None,
    };
    let mut journal = FakeJournal::default();
    let mut asker = FakeAsker {
        answers: list(scenario, "answers").iter().cloned().collect(),
        asks: Vec::new(),
        messages: messages_of(scenario),
    };
    let (value, error) = {
        let mut install = Install::new(
            &machine,
            &mut screen,
            &mut journal,
            &mut asker,
            messages_of(scenario),
        );
        run_op(scenario, &mut install, &app_dir, &mut out)
    };
    let unfill = |value: &str| placeholders(&value.replace(&*sys.to_string_lossy(), "{sys}"), root);
    let unfilled = |value: &Value| parse(&unfill(&value.to_string()));

    assert!(
        asker.answers.is_empty(),
        "{}: answers left",
        text(scenario, "name")
    );

    Run {
        out: unfill(&out.text()),
        err: if tty.is_some() {
            String::new()
        } else {
            unfill(&err.text())
        },
        value: unfilled(&value),
        error: unfilled(&error),
        path: unfill(&system.path().unwrap().to_string_lossy()),
        asks: unfilled(&Value::Array(asker.asks)),
        journal: unfilled(&Value::Array(journal.calls)),
        undos: journal.undos.iter().map(|undo| unfill(undo)).collect(),
    }
}

fn dash_form(stderr: &str) -> String {
    stderr
        .split_inclusive('\n')
        .map(|line| {
            let (body, end) = line
                .strip_suffix('\n')
                .map_or((line, ""), |body| (body, "\n"));

            body.strip_prefix("sh: ")
                .and_then(|rest| rest.strip_suffix(": command not found"))
                .map_or_else(
                    || line.to_owned(),
                    |command| format!("sh: 1: {command}: not found{end}"),
                )
        })
        .collect()
}

#[test]
fn rewrites_only_the_not_found_line_of_a_bash_sh_in_the_dash_form() {
    assert_eq!(
        dash_form("sh: curl: command not found\n"),
        "sh: 1: curl: not found\n"
    );
    assert_eq!(
        dash_form("sh: 1: curl: not found\n"),
        "sh: 1: curl: not found\n"
    );
    assert_eq!(
        dash_form("a\nsh: uv: command not found"),
        "a\nsh: 1: uv: not found"
    );
    assert_eq!(
        dash_form("other: command not found\n"),
        "other: command not found\n"
    );
    assert_eq!(dash_form(""), "");
}

#[test]
fn every_scenario_prints_asks_records_and_writes_like_setup_mjs() {
    let fixture = parse(FIXTURE);
    let sys = sys_dir();
    let default_mode = default_file_mode();

    for scenario in list(&fixture, "scenarios") {
        let name = text(scenario, "name");
        let root = sandbox();
        let scenario = &app_form(scenario, text(&scenario["env"], "BETTER_CC_TELEGRAM_DIR"));
        materialize(root.path(), &scenario["files"]);

        let run = replay(scenario, root.path(), sys.path());

        assert_eq!(run.out, text(scenario, "stdout"), "{name}: stdout");
        assert_eq!(
            dash_form(&run.err),
            text(scenario, "stderr"),
            "{name}: stderr"
        );
        assert_eq!(run.error, scenario["error"], "{name}: error");
        assert_eq!(run.value, scenario["value"], "{name}: value");
        assert_eq!(run.path, text(scenario, "path"), "{name}: path");
        assert_eq!(run.asks, scenario["asks"], "{name}: asks");
        assert_eq!(run.journal, scenario["journal"], "{name}: journal");
        assert_eq!(run.undos, strings(&scenario["undoCalls"]), "{name}: undo");
        assert_eq!(
            snapshot(root.path()),
            expected_tree(&scenario["after"], None, &default_mode),
            "{name}: files"
        );
    }
}

struct Failing(&'static str);

impl Write for Failing {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if String::from_utf8_lossy(buf).contains(self.0) {
            Err(io::ErrorKind::BrokenPipe.into())
        } else {
            Ok(buf.len())
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn stopped_by(
    needle: &'static str,
    answers: &[Value],
    prepare: impl FnOnce(&Path),
    work: impl FnOnce(&mut Install<'_, '_, String>, &Path) -> Result<(), Failure<String>>,
) -> Result<(), Failure<String>> {
    let root = sandbox();
    let sys = sys_dir();
    let bin = root.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("claude"), "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(
        bin.join("claude"),
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    prepare(root.path());

    let home = root.path().join("home");
    let hub = root.path().join("hub");
    let settings = root.path().join("settings.json");
    let app_dir = root.path().join("app");
    let source = marketplace();
    let system = System::new(vec![(
        OsString::from("PATH"),
        OsString::from(format!("{}:{}", bin.display(), sys.path().display())),
    )]);
    let machine = Machine {
        home: &home,
        app_dir: &app_dir,
        marketplace: &source,
        hf_cache: &hub,
        settings_file: &settings,
        shell: Some("bash"),
        macos: false,
        system: &system,
        run_installer: &|system: &System, command: &str| system.run_installer(command),
        chromium: &|| None,
    };
    let mut out = Failing(needle);
    let mut err = Vec::new();
    let mut screen = Screen {
        out: &mut out,
        err: &mut err,
        terminal: Some(Terminal { columns: None }),
        colorize_out: false,
        colorize_err: false,
        spin: &|_, _| None,
    };
    let mut journal = FakeJournal::default();
    let mut asker = FakeAsker {
        answers: answers.iter().cloned().collect(),
        asks: Vec::new(),
        messages: messages_for(Locale::EnUs),
    };
    let mut install = Install::new(
        &machine,
        &mut screen,
        &mut journal,
        &mut asker,
        messages_for(Locale::EnUs),
    );

    work(&mut install, root.path())
}

#[test]
fn a_line_or_an_answer_that_fails_stops_the_step() {
    let everything = PluginChoice {
        marketplaces: MARKETPLACE_NAME.to_owned(),
        plugins: PLUGIN_IDS.join("\n"),
        plugin_ids: PLUGIN_IDS.to_vec(),
        removed_ids: Vec::new(),
    };

    for needle in [
        "already registered",
        "disabled outside",
        "enabled in every instance",
    ] {
        assert_eq!(
            stopped_by(
                needle,
                &[],
                |_| {},
                |install, _| install.ensure_plugins(&everything)
            ),
            Err(Failure::Screen),
            "{needle}"
        );
    }

    for needle in ["Checking", "Checked"] {
        assert_eq!(
            stopped_by(
                needle,
                &[],
                |_| {},
                |install, _| install.confirm_plugin_step().map(|_| ())
            ),
            Err(Failure::Screen),
            "{needle}"
        );
    }

    assert_eq!(
        stopped_by(
            "Removing mermaid",
            &[json!(true)],
            |root| {
                let mmdc = root.join("bin/mmdc");
                std::fs::write(&mmdc, "#!/bin/sh\nexit 0\n").unwrap();
                std::fs::set_permissions(mmdc, std::os::unix::fs::PermissionsExt::from_mode(0o755))
                    .unwrap();
            },
            |install, _| install.remove_mermaid()
        ),
        Err(Failure::Screen)
    );
    assert_eq!(
        stopped_by(
            "Deleting the transcription",
            &[json!(true)],
            |root| std::fs::create_dir_all(root.join("app/whisper")).unwrap(),
            |install, root| install.remove_transcription(&root.join("app"))
        ),
        Err(Failure::Screen)
    );

    let installed = |root: &Path| {
        let venv = root.join("app/whisper/venv/bin");
        std::fs::create_dir_all(&venv).unwrap();
        std::fs::write(venv.join("python"), "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(
            venv.join("python"),
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();

        for model in ["base", "small"] {
            std::fs::create_dir_all(
                root.join(format!("hub/models--Systran--faster-whisper-{model}")),
            )
            .unwrap();
        }
    };

    assert_eq!(
        stopped_by(
            "\u{0}",
            &[json!("small"), json!({"stop": true})],
            installed,
            |install, root| install.ensure_transcription(&root.join("app"))
        ),
        Err(Failure::Asking("stop".to_owned()))
    );
}

#[test]
fn the_constants_match_the_js() {
    let fixture = parse(FIXTURE);
    let constants = &fixture["constants"];

    assert_eq!(text(constants, "marketplace"), MARKETPLACE_NAME);
    assert_eq!(strings(&constants["pluginIds"]), PLUGIN_IDS);
    assert_eq!(
        text(constants, "mermaidUninstallCommand"),
        MERMAID_UNINSTALL_COMMAND
    );
    assert_eq!(
        text(constants, "manualUninstallCommands"),
        manual_uninstall_commands()
    );
}

#[test]
fn the_git_version_is_the_third_word_and_a_missing_or_failing_git_has_none() {
    let folder = sandbox();
    let script = |name: &str, body: &str| {
        let path = folder.path().join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        path
    };
    let apple = script("apple", "echo 'git version 2.39.3 (Apple Git-145)'");
    let failing = script("failing", "echo 'git version 2.43.0'; exit 1");
    let short = script("short", "echo 'git'");

    assert_eq!(
        git_version_from(Command::new(apple)).as_deref(),
        Some("2.39.3")
    );
    assert_eq!(git_version_from(Command::new(failing)), None);
    assert_eq!(git_version_from(Command::new(short)), None);
    assert_eq!(
        git_version_from(Command::new(folder.path().join("missing"))),
        None
    );
}

#[test]
fn picks_the_installer_of_each_tool_like_the_js() {
    for case in list(&parse(FIXTURE), "installerFor") {
        let found = Tool::parse(text(case, "tool"))
            .map(|tool| installer_for(tool, Path::new(text(case, "home"))))
            .map_or(Value::Null, |installer| {
                json!({"command": installer.command, "binDir": installer.bin_dir.to_string_lossy()})
            });

        assert_eq!(found, case["installer"], "{case}");
    }
}

#[test]
fn picks_the_powershell_installer_of_each_tool_on_windows() {
    let home = Path::new("C:\\Users\\dev");

    assert_eq!(
        [Tool::Claude, Tool::Bun, Tool::Uv].map(|tool| installer_in(PathFlavor::Win32, tool, home)),
        [
            Installer {
                command: "& ([scriptblock]::Create((irm https://claude.ai/install.ps1))) 2.1.303"
                    .to_owned(),
                bin_dir: PathBuf::from("C:\\Users\\dev\\.local\\bin"),
            },
            Installer {
                command:
                    "& ([scriptblock]::Create((irm https://bun.com/install.ps1))) -Version 1.4.3"
                        .to_owned(),
                bin_dir: PathBuf::from("C:\\Users\\dev\\.bun\\bin"),
            },
            Installer {
                command: "irm https://astral.sh/uv/0.13.1/install.ps1 | iex".to_owned(),
                bin_dir: PathBuf::from("C:\\Users\\dev\\.local\\bin"),
            },
        ]
    );
    assert_eq!(
        installer_in(PathFlavor::Posix, Tool::Uv, Path::new("/h")),
        installer_for(Tool::Uv, Path::new("/h"))
    );
}

#[test]
fn runs_the_installer_in_powershell_on_windows_and_returns_its_exit_code() {
    let root = sandbox();
    let bin = root.path().join("bin");
    let empty = root.path().join("empty");
    let powershell = bin.join("powershell");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&empty).unwrap();
    std::fs::write(
        &powershell,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"${0%/*}/arguments\"\nexit 7\n",
    )
    .unwrap();
    std::fs::set_permissions(
        &powershell,
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    let path_to = |folder: &Path| {
        System::new(vec![(
            OsString::from("PATH"),
            folder.as_os_str().to_owned(),
        )])
    };
    let command = "irm https://astral.sh/uv/0.13.1/install.ps1 | iex";

    assert_eq!(
        path_to(&bin).run_installer_in(PathFlavor::Win32, command),
        Some(7)
    );
    assert_eq!(
        std::fs::read_to_string(bin.join("arguments")).unwrap(),
        format!("-NoProfile\n-ExecutionPolicy\nByPass\n-Command\n{command}\n")
    );
    assert_eq!(
        path_to(&empty).run_installer_in(PathFlavor::Win32, command),
        None
    );
}

#[test]
fn finds_the_whisper_python_of_each_platform_like_the_channel() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../plugins/telegram/extensions/__tests__/fixtures/whisper-python.json"
    ))
    .unwrap();

    assert_eq!(cases.len(), 3);

    for case in &cases {
        let flavor = if text(case, "platform") == "win32" {
            PathFlavor::Win32
        } else {
            PathFlavor::Posix
        };

        assert_eq!(
            whisper_python_in(flavor, text(case, "appDir")),
            text(case, "python"),
            "{case}"
        );
    }
}

#[test]
fn installs_whisper_with_the_pip_of_the_venv_of_each_platform() {
    assert_eq!(
        venv_layout(PathFlavor::Posix),
        VenvLayout {
            python: "bin/python",
            pip: "bin/pip",
        }
    );
    assert_eq!(
        venv_layout(PathFlavor::Win32),
        VenvLayout {
            python: "Scripts/python.exe",
            pip: "Scripts/pip.exe",
        }
    );
}

#[test]
fn creates_the_whisper_venv_with_the_python_of_each_platform() {
    assert_eq!(
        [PathFlavor::Posix, PathFlavor::Win32].map(python_program),
        ["python3", "py"]
    );
    assert_eq!(
        uv_venv_args(PathFlavor::Posix, "/h/venv"),
        ["venv", "/h/venv", "--python", "python3", "--clear", "-q"]
    );
    assert_eq!(
        uv_venv_args(PathFlavor::Win32, "C:\\h\\venv"),
        ["venv", "C:\\h\\venv", "--clear", "-q"]
    );
}

#[test]
fn hints_the_python_installers_of_each_platform_when_the_venv_fails() {
    let messages = messages_for(Locale::EnUs);

    assert_eq!(
        [PathFlavor::Posix, PathFlavor::Win32].map(|flavor| python_env_failed_in(flavor, messages)),
        [
            "Could not create the Python environment. Install one of these and run the setup again:\n  • uv (curl -LsSf https://astral.sh/uv/install.sh | sh)\n  • Python's venv (on Debian and Ubuntu, sudo apt install python3-venv)",
            "Could not create the Python environment. Install one of these and run the setup again:\n  • uv (powershell -ExecutionPolicy ByPass -c \"irm https://astral.sh/uv/install.ps1 | iex\")\n  • Python from python.org, which brings the py launcher (https://www.python.org/downloads/)",
        ]
    );
}

#[test]
fn the_hugging_face_cache_follows_the_same_variables() {
    for case in list(&parse(FIXTURE), "huggingFaceCacheDir") {
        let env = case["env"].as_object().unwrap();
        let var = |name: &str| {
            env.get(name)
                .map(|value| OsString::from(value.as_str().unwrap()))
        };

        assert_eq!(
            huggingface_cache_dir(&var, Path::new(text(case, "home"))).to_string_lossy(),
            text(case, "dir"),
            "{case}"
        );
    }
}

fn parsed_json<T>(parsed: Parsed<T>, value: impl Fn(T) -> Value) -> Value {
    match parsed {
        Parsed::Value(found) => value(found),
        Parsed::Off => Value::Null,
        Parsed::Keep => json!("keep"),
    }
}

#[test]
fn answers_are_parsed_like_the_js() {
    let fixture = parse(FIXTURE);

    for case in list(&fixture, "parseTranscriptionModel") {
        assert_eq!(
            parsed_json(
                parse_transcription_model(text(case, "answer")),
                |model| json!(model)
            ),
            case["result"],
            "{case}"
        );
    }

    for case in list(&fixture, "parseInboxDays") {
        assert_eq!(
            parsed_json(parse_inbox_days(text(case, "answer")), number),
            case["result"],
            "{case}"
        );
    }
}

#[test]
fn plans_the_plugins_like_the_js() {
    for case in list(&parse(FIXTURE), "pluginPlan") {
        let input = &case["input"];
        let rc_files: Vec<PathBuf> = strings(&input["rcFiles"])
            .iter()
            .map(PathBuf::from)
            .collect();
        let plugin_ids: Vec<&'static str> = if input["pluginIds"].is_null() {
            PLUGIN_IDS.to_vec()
        } else {
            strings(&input["pluginIds"])
                .iter()
                .map(|id| plugin(id))
                .collect()
        };
        let plan = plugin_plan(
            Installed {
                marketplaces: text(input, "marketplaces"),
                plugins: text(input, "plugins"),
                rc_files: &rc_files,
                plugin_ids: &plugin_ids,
            },
            messages_for(Locale::parse(text(case, "locale")).unwrap()),
            "/repo",
            Path::new("/repo/shell.sh"),
        );
        let plan: Vec<Value> = plan
            .into_iter()
            .map(|step| json!({"description": step.description, "command": step.command}))
            .collect();

        assert_eq!(Value::Array(plan), case["plan"], "{case}");
    }
}
