#![cfg(unix)]
#![cfg(test)]

#[path = "support/pty.rs"]
mod pty;

use std::env;
use std::fs;
use std::io::{self, Write};
use std::thread;
use std::time::Duration;

use bcct::js::{js_number, js_trim, parse_json, stringify};
use bcct::messages::{EN_US, Messages, PT_BR};
use bcct::prompt::{
    Choice, ChoiceQuestion, GuardCancel, Other, PromptError, Prompter, ask_choice, ask_validated,
    ask_yes_no, create_prompter, index_of_value, marked, number_choices,
};
use pty::{Redirect, Run, Step, between, record};
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("fixtures/setup-terminal.json");
const DRIVE: &str = "BCCT_DRIVE";
const ROWS: u16 = 24;
const JOB_NOTICES: [&str; 3] = ["\r\n[1]+", "\r\n[1]  + ", "\r\nzsh: "];
const LINE_END: &str = "\r\n";
const DELAY_PRESETS: [f64; 6] = [1.0, 3.0, 4.0, 5.0, 10.0, 15.0];
const RECOMMENDED_DELAY: f64 = 4.0;

fn fixture() -> Value {
    parse_json(FIXTURE).unwrap()
}

fn views(choices: &Value) -> Vec<Choice> {
    choices
        .as_array()
        .unwrap()
        .iter()
        .map(|choice| Choice {
            label: choice["label"].as_str().unwrap().to_owned(),
            hint: choice["hint"].as_str().map(str::to_owned),
            heading: choice["heading"].as_bool().unwrap_or(false),
            previous: choice["previous"].as_bool().unwrap_or(false),
        })
        .collect()
}

fn error_json(error: &PromptError) -> Value {
    let (message, cancelled, interrupted) = match error {
        PromptError::Cancelled(message) => ((*message).to_owned(), true, false),
        PromptError::Interrupted(message) => ((*message).to_owned(), false, true),
        PromptError::Ended(message) | PromptError::Aborted(message) => {
            ((*message).to_owned(), false, false)
        }
        PromptError::Io(error) => (error.to_string(), false, false),
        PromptError::Back => (error.to_string(), false, false),
    };

    json!({ "message": message, "cancelled": cancelled, "interrupted": interrupted })
}

fn settled(outcome: Result<Value, PromptError>) -> Value {
    match outcome {
        Ok(value) => json!({ "value": value }),
        Err(error) => json!({ "error": error_json(&error) }),
    }
}

fn parse_minutes(typed: &str) -> Option<f64> {
    let minutes = js_number(&js_trim(typed).replacen(',', ".", 1));

    (!js_trim(typed).is_empty() && minutes.is_finite() && minutes > 0.0).then_some(minutes)
}

fn ask_delay(
    current: f64,
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Result<Value, PromptError> {
    let options = number_choices(&DELAY_PRESETS, Some(current), &|minutes| {
        (messages.delay_label)(minutes)
    });
    let index = index_of_value(&options, &current);
    let choices = marked(
        options,
        index,
        false,
        &|choice| {
            if choice.value() == Some(&RECOMMENDED_DELAY) {
                vec![messages.recommended.to_owned()]
            } else {
                Vec::new()
            }
        },
        messages,
    );
    let mut custom = |terminal: &mut dyn Prompter| {
        ask_validated(
            messages.delay_custom_prompt,
            &parse_minutes,
            messages.delay_custom_hint,
            messages,
            terminal,
        )
    };
    let question = ChoiceQuestion {
        title: messages.delay_question.to_owned(),
        choices,
        index,
        other: Some(Other {
            label: messages.custom.to_owned(),
            answer: "N".to_owned(),
            parse: &parse_minutes,
            ask_on_terminal: &mut custom,
        }),
        default_hint: None,
    };

    ask_choice(question, messages, ask)
        .map(|minutes| parse_json(&bcct::js::format_number(minutes)).unwrap())
}

fn terminal_modes() -> Result<Value, PromptError> {
    use bcct::prompt::{Console, StdConsole};
    use rustix::termios::{
        ControlModes, InputModes, LocalModes, OptionalActions, OutputModes, SpecialCodeIndex,
        Termios, tcgetattr, tcsetattr,
    };

    let stdin = io::stdin();
    let mut prepared = tcgetattr(&stdin).unwrap();

    prepared.input_modes |= InputModes::BRKINT
        | InputModes::ICRNL
        | InputModes::INPCK
        | InputModes::ISTRIP
        | InputModes::IXON;
    prepared.output_modes -= OutputModes::ONLCR;
    prepared.control_modes -= ControlModes::CSIZE;
    prepared.control_modes |= ControlModes::CS7;
    prepared.local_modes |=
        LocalModes::ECHO | LocalModes::ICANON | LocalModes::IEXTEN | LocalModes::ISIG;
    prepared.special_codes[SpecialCodeIndex::VMIN] = 5;
    prepared.special_codes[SpecialCodeIndex::VTIME] = 3;
    tcsetattr(&stdin, OptionalActions::Now, &prepared).unwrap();

    let prepared = tcgetattr(&stdin).unwrap();

    let shape = |modes: &Termios| {
        json!({
            "input": modes.input_modes.bits(),
            "output": modes.output_modes.bits(),
            "size": (modes.control_modes & ControlModes::CSIZE).bits(),
            "local": (modes.local_modes - LocalModes::PENDIN).bits(),
            "min": modes.special_codes[SpecialCodeIndex::VMIN],
            "time": modes.special_codes[SpecialCodeIndex::VTIME],
        })
    };
    let mut console = StdConsole::new();

    console.set_raw(true)?;
    console.set_raw(true)?;

    let raw = tcgetattr(&stdin).unwrap();

    console.set_raw(false)?;

    let restored = tcgetattr(&stdin).unwrap();
    let cleared = InputModes::BRKINT
        | InputModes::ICRNL
        | InputModes::INPCK
        | InputModes::ISTRIP
        | InputModes::IXON;
    let quiet = LocalModes::ECHO | LocalModes::ICANON | LocalModes::IEXTEN | LocalModes::ISIG;

    Ok(json!({
        "raw": {
            "inputCleared": (raw.input_modes & cleared).is_empty(),
            "inputKept": raw.input_modes | cleared == prepared.input_modes | cleared,
            "onlcr": raw.output_modes.contains(OutputModes::ONLCR),
            "outputKept": raw.output_modes - OutputModes::ONLCR == prepared.output_modes,
            "cs8": (raw.control_modes & ControlModes::CSIZE) == ControlModes::CS8,
            "localCleared": (raw.local_modes & quiet).is_empty(),
            "localKept": raw.local_modes | quiet == prepared.local_modes,
            "min": raw.special_codes[SpecialCodeIndex::VMIN],
            "time": raw.special_codes[SpecialCodeIndex::VTIME],
        },
        "restored": shape(&restored) == shape(&prepared),
    }))
}

#[test]
#[ignore = "runs only inside the terminal opened by the other tests of this file"]
fn pty_driver() {
    let Some(spec) = env::var(DRIVE).ok().and_then(|spec| parse_json(&spec)) else {
        return;
    };
    let var = |name: &str| env::var_os(name);
    let messages = if spec["locale"] == "pt-br" {
        &PT_BR
    } else {
        &EN_US
    };
    let prompt = spec["text"].as_str().unwrap_or_default();
    let mut prompter = create_prompter(&var);
    let mut stdout = io::stdout();

    stdout.write_all(pty::START).unwrap();
    stdout.flush().unwrap();

    let outcome = match spec["kind"].as_str().unwrap() {
        "select" => {
            let index = usize::try_from(spec["index"].as_u64().unwrap()).unwrap();

            prompter
                .select(prompt, &views(&spec["choices"]), index, messages)
                .map(|chosen| json!(chosen))
        }
        "guard" => GuardCancel::new(&mut *prompter)
            .line(prompt, messages)
            .map(Value::from),
        "yesno" => ask_yes_no(prompt, messages, true, &mut *prompter).map(Value::from),
        "termios" => terminal_modes(),
        "selectline" => {
            let index = usize::try_from(spec["index"].as_u64().unwrap()).unwrap();

            prompter
                .select(prompt, &views(&spec["choices"]), index, messages)
                .and_then(|chosen| {
                    let typed = prompter.line("Minutes? ", messages)?;

                    Ok(json!([chosen, typed]))
                })
        }
        "pausedline" => {
            let index = usize::try_from(spec["index"].as_u64().unwrap()).unwrap();

            prompter
                .select(prompt, &views(&spec["choices"]), index, messages)
                .and_then(|chosen| {
                    thread::sleep(Duration::from_millis(spec["pause"].as_u64().unwrap()));

                    let typed = prompter.line("Minutes? ", messages)?;

                    Ok(json!([chosen, typed]))
                })
        }
        "delay" => ask_delay(spec["current"].as_f64().unwrap(), messages, &mut *prompter),
        "hidden" => prompter.hidden(prompt, messages).map(Value::from),
        _ => prompter.line(prompt, messages).map(Value::from),
    };

    prompter.close();

    let tail = format!(
        "{}{}\n",
        String::from_utf8_lossy(pty::END),
        settled(outcome)
    );

    stdout.write_all(tail.as_bytes()).unwrap();
    stdout.flush().unwrap();
}

fn driver_argv() -> Vec<String> {
    [
        env::current_exe().unwrap().to_string_lossy().into_owned(),
        "pty_driver".to_owned(),
        "--exact".to_owned(),
        "--ignored".to_owned(),
        "--nocapture".to_owned(),
        "--test-threads".to_owned(),
        "1".to_owned(),
    ]
    .into()
}

fn drive(spec: &Value, columns: u16, steps: &[Step], redirect: bool) -> (String, Value) {
    let folder = tempfile::tempdir().unwrap();
    let file = folder.path().join("out");
    let argv = driver_argv();
    let env = [(DRIVE.to_owned(), spec.to_string())];
    let output = record(&Run {
        argv: &argv,
        env: &env,
        columns,
        rows: ROWS,
        steps,
        redirect: redirect.then_some(Redirect::File(file.as_path())),
    })
    .unwrap();
    let text = if redirect {
        fs::read(&file).unwrap()
    } else {
        output
    };
    let (flow, outcome) = between(&text).unwrap();

    (
        String::from_utf8(flow.to_vec()).unwrap(),
        serde_json::from_slice(outcome).unwrap(),
    )
}

fn key_steps(keys: &Value) -> Vec<Step> {
    keys.as_array()
        .unwrap()
        .iter()
        .map(|key| {
            if let Some(columns) = key.get("columns") {
                return Step::Resize(u16::try_from(columns.as_u64().unwrap()).unwrap());
            }

            if let Some(milliseconds) = key.get("pause") {
                return Step::Pause(milliseconds.as_u64().unwrap());
            }

            Step::Key(key.as_str().unwrap().as_bytes().to_vec())
        })
        .collect()
}

fn driven(ptys: &Value) -> Vec<(Value, String, Value)> {
    let runs: Vec<_> = ptys
        .as_array()
        .unwrap()
        .iter()
        .cloned()
        .map(|entry| {
            thread::spawn(move || {
                let columns = u16::try_from(entry["columns"].as_u64().unwrap()).unwrap();
                let redirect = entry["redirect"].as_bool().unwrap();
                let (flow, outcome) = drive(
                    &entry["spec"],
                    columns,
                    &key_steps(&entry["keys"]),
                    redirect,
                );

                (entry, flow, outcome)
            })
        })
        .collect();

    runs.into_iter().map(|run| run.join().unwrap()).collect()
}

#[test]
fn blessing_rewrites_the_terminal_ptys_from_the_binary() {
    if env::var_os("BCCT_BLESS").is_none_or(|flag| flag != "1") {
        return;
    }

    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/setup-terminal.json");
    let mut fixture = parse_json(&fs::read_to_string(&path).unwrap()).unwrap();
    let observed = driven(&fixture["ptys"]);

    for (entry, (_, flow, outcome)) in fixture["ptys"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip(observed)
    {
        entry["output"] = Value::String(flow);
        entry["outcome"] = outcome;
    }

    fs::write(path, stringify(&fixture)).unwrap();
}

#[test]
fn writes_in_the_real_terminal_what_the_js_writes() {
    let fixture = fixture();

    for (entry, flow, outcome) in driven(&fixture["ptys"]) {
        let name = entry["name"].as_str().unwrap();

        assert_eq!(flow, entry["output"].as_str().unwrap(), "{name}");
        assert_eq!(outcome, entry["outcome"], "{name}");
    }
}

#[test]
fn the_raw_mode_is_the_one_of_node_and_gives_the_terminal_back() {
    let (flow, outcome) = drive(&json!({ "kind": "termios" }), 40, &[], false);

    assert_eq!(flow, "");
    assert_eq!(
        outcome,
        json!({ "value": {
            "raw": {
                "inputCleared": true,
                "inputKept": true,
                "onlcr": true,
                "outputKept": true,
                "cs8": true,
                "localCleared": true,
                "localKept": true,
                "min": 1,
                "time": 0,
            },
            "restored": true,
        } })
    );
}

#[test]
fn a_key_release_reported_by_the_terminal_types_nothing() {
    let spec = json!({ "kind": "line", "text": "Q? ", "locale": "en-us" });
    let steps = key_steps(&json!(["\u{1b}[97;1:3u", "b", "\r"]));
    let (flow, outcome) = drive(&spec, 40, &steps, false);

    assert_eq!(flow, "\u{1b}[1G\u{1b}[0JQ? \u{1b}[4Gb\r\r\n");
    assert_eq!(outcome, json!({ "value": "b" }));
}

fn without_job_notice(flow: &str) -> String {
    let Some(start) = JOB_NOTICES
        .iter()
        .filter_map(|notice| flow.find(notice))
        .min()
    else {
        return flow.to_owned();
    };
    let after = start + LINE_END.len();
    let end = flow
        .get(after..)
        .and_then(|rest| rest.find(LINE_END))
        .map_or(flow.len(), |offset| after + offset + LINE_END.len());

    without_job_notice(&format!(
        "{}{}",
        flow.get(..start).unwrap_or_default(),
        flow.get(end..).unwrap_or_default()
    ))
}

#[test]
fn drops_the_job_notices_that_bash_and_zsh_print() {
    let printed =
        "\u{1b}[1G\u{1b}[0JQ? a\u{1b}[5G\r\n[1]+  Stopped                 \"$@\"\r\nb\r\r\n";

    assert_eq!(
        without_job_notice(printed),
        "\u{1b}[1G\u{1b}[0JQ? a\u{1b}[5Gb\r\r\n"
    );
    assert_eq!(without_job_notice("Q? b\r\r\n"), "Q? b\r\r\n");
    assert_eq!(
        without_job_notice(
            "Q? a\r\nzsh: suspended  \"$@\"\r\n\r\n[1]  + continued  \"$@\"\r\nb\r\r\n"
        ),
        "Q? ab\r\r\n"
    );
}

#[test]
fn ctrl_z_suspends_a_typed_question_and_fg_goes_on_asking_it() {
    let script = format!(
        "{}; \"$@\"; first=$?; fg > /dev/null; last=$?; echo \"statuses=$first $last\"",
        pty::JOB_CONTROL
    );
    let mut argv = vec![
        pty::JOB_SHELL.to_owned(),
        "-c".to_owned(),
        script,
        "bcct".to_owned(),
    ];

    argv.extend(driver_argv());

    let spec = json!({ "kind": "line", "text": "Q? ", "locale": "en-us" });
    let env = [(DRIVE.to_owned(), spec.to_string())];
    let steps = key_steps(&json!(["a", "\u{1a}", "b", "\r"]));
    let output = record(&Run {
        argv: &argv,
        env: &env,
        columns: 40,
        rows: ROWS,
        steps: &steps,
        redirect: None,
    })
    .unwrap();
    let (flow, outcome) = between(&output).unwrap();

    assert_eq!(
        without_job_notice(&String::from_utf8_lossy(flow)),
        "\u{1b}[1G\u{1b}[0JQ? \u{1b}[4Ga\
         \u{1b}[1G\u{1b}[0JQ? a\u{1b}[5Gb\r\r\n"
    );
    assert_eq!(
        serde_json::from_slice::<Value>(outcome).unwrap(),
        json!({ "value": "ab" })
    );
    assert!(
        String::from_utf8_lossy(&output).ends_with("statuses=148 0\r\n"),
        "{}",
        String::from_utf8_lossy(&output)
    );
}

#[test]
fn a_resized_terminal_redraws_the_choices_with_its_new_width() {
    let fixture = fixture();
    let session = fixture["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "select redraws with the width of each moment")
        .unwrap();
    let steps: Vec<Step> = session["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|key| match key.get("columns") {
            Some(columns) => Step::Resize(u16::try_from(columns.as_u64().unwrap()).unwrap()),
            None => Step::Key(
                match key.as_str().unwrap() {
                    "down" => "\u{1b}[B",
                    "up" => "\u{1b}[A",
                    _ => "\r",
                }
                .as_bytes()
                .to_vec(),
            ),
        })
        .collect();
    let spec = json!({
        "kind": "select",
        "text": session["text"],
        "choices": session["choices"],
        "index": session["index"],
        "locale": session["locale"],
    });
    let columns = u16::try_from(session["columns"].as_u64().unwrap()).unwrap();
    let (flow, outcome) = drive(&spec, columns, &steps, false);

    assert_eq!(
        flow,
        session["written"].as_str().unwrap().replace('\n', "\r\n")
    );
    assert_eq!(outcome, json!({ "value": session["value"] }));
}
