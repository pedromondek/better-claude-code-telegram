#![cfg(test)]

mod support;

use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::io::{self, Cursor};

use bcct::js::{js_number, parse_json};
use bcct::messages::{EN_US, Messages, PT_BR};
use bcct::prompt::{
    Answer, Choice, ChoiceItem, ChoiceQuestion, Colors, Console, FakeCall, FakePrompter,
    GuardCancel, Input, LineReader, Other, PipedPrompter, PromptError, Prompter, Reply,
    TerminalPrompter, ask_choice, ask_validated, ask_yes_no, index_of_value, marked,
    number_choices, render_choices, strip_vt_control_characters,
};
use bcct::ui::should_colorize;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::{Value, json};
use support::{list, text};

const FIXTURE: &str = include_str!("fixtures/setup-terminal.json");
const DELAY_PRESETS: [f64; 6] = [1.0, 3.0, 4.0, 5.0, 10.0, 15.0];
const INBOX_PRESETS: [f64; 5] = [1.0, 3.0, 7.0, 14.0, 30.0];
const RECOMMENDED_DELAY: f64 = 4.0;

fn fixture() -> Value {
    parse_json(FIXTURE).unwrap()
}

fn messages(locale: &str) -> &'static Messages {
    if locale == "pt-br" { &PT_BR } else { &EN_US }
}

fn variables(env: &Value) -> HashMap<String, OsString> {
    env.as_object()
        .unwrap()
        .iter()
        .map(|(name, value)| (name.clone(), OsString::from(value.as_str().unwrap())))
        .collect()
}

fn colors(env: &Value, terminal: bool) -> Colors {
    let variables = variables(env);
    let var = |name: &str| variables.get(name).cloned();

    Colors {
        out: should_colorize(&var, terminal),
        err: should_colorize(&var, terminal),
    }
}

fn view(choice: &Value) -> Choice {
    Choice {
        label: text(choice, "label").to_owned(),
        hint: choice["hint"].as_str().map(str::to_owned),
        heading: choice["heading"].as_bool().unwrap_or(false),
        previous: choice["previous"].as_bool().unwrap_or(false),
    }
}

fn views(choices: &Value) -> Vec<Choice> {
    choices.as_array().unwrap().iter().map(view).collect()
}

fn error_json(error: &PromptError) -> Value {
    match error {
        PromptError::Cancelled(message) => {
            json!({ "message": message, "cancelled": true, "interrupted": false })
        }
        PromptError::Ended(message) | PromptError::Aborted(message) => {
            json!({ "message": message, "cancelled": false, "interrupted": false })
        }
        PromptError::Interrupted(message) => {
            json!({ "message": message, "cancelled": false, "interrupted": true })
        }
        PromptError::Io(_) => {
            json!({ "message": "network", "cancelled": false, "interrupted": false })
        }
    }
}

fn same(actual: &Value, expected: &Value) -> bool {
    match (actual.as_f64(), expected.as_f64()) {
        (Some(left), Some(right)) => left.total_cmp(&right).is_eq(),
        _ => actual == expected,
    }
}

fn check_outcome<T: Into<Value>>(name: &str, answer: Answer<T>, entry: &Value) {
    match answer {
        Ok(value) => {
            let value = value.into();

            assert!(
                entry.get("error").is_none(),
                "{name}: expected an error, got {value}"
            );
            assert!(
                same(&value, &entry["value"]),
                "{name}: {value} != {}",
                entry["value"]
            );
        }
        Err(error) => assert_eq!(error_json(&error), entry["error"], "{name}"),
    }
}

#[test]
fn render_choices_matches_the_js() {
    let fixture = fixture();

    for entry in list(&fixture, "renders") {
        let name = text(entry, "name");
        let columns = entry["columns"]
            .as_u64()
            .map(|value| u16::try_from(value).unwrap());
        let lines = render_choices(
            &views(&entry["choices"]),
            usize::try_from(entry["index"].as_u64().unwrap()).unwrap(),
            text(entry, "hint"),
            columns,
            colors(&entry["env"], true).out,
        );
        let expected: Vec<String> = entry["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|line| line.as_str().unwrap().to_owned())
            .collect();

        assert_eq!(lines, expected, "{name}");
    }
}

#[test]
fn stripping_terminal_codes_matches_node() {
    let fixture = fixture();

    for entry in list(&fixture, "strips") {
        assert_eq!(
            strip_vt_control_characters(text(entry, "text")),
            text(entry, "out"),
            "{:?}",
            text(entry, "text")
        );
    }
}

#[derive(Debug)]
enum Step {
    Key(KeyEvent),
    Chunk(Vec<u8>),
    Columns(Option<u16>),
}

#[derive(Debug)]
struct Scripted {
    steps: VecDeque<Step>,
    lines: LineReader<Cursor<Vec<u8>>>,
    columns: Option<u16>,
    output_terminal: bool,
    written: String,
    raw: Vec<bool>,
}

impl Scripted {
    fn next(&mut self) -> io::Result<Step> {
        self.steps
            .pop_front()
            .ok_or_else(|| io::Error::from(io::ErrorKind::UnexpectedEof))
    }
}

impl Console for Scripted {
    fn set_raw(&mut self, on: bool) -> io::Result<()> {
        self.raw.push(on);
        Ok(())
    }

    fn columns(&self) -> Option<u16> {
        self.columns
    }

    fn output_is_terminal(&self) -> bool {
        self.output_terminal
    }

    fn read_input(&mut self) -> io::Result<Input> {
        match self.next()? {
            Step::Key(key) => Ok(Input::Key(key)),
            Step::Columns(columns) => {
                self.columns = columns;
                Ok(Input::Resized)
            }
            other @ Step::Chunk(_) => panic!("expected a key, got {other:?}"),
        }
    }

    fn read_chunk(&mut self) -> io::Result<Vec<u8>> {
        match self.next() {
            Ok(Step::Chunk(bytes)) => Ok(bytes),
            Ok(other) => panic!("expected bytes, got {other:?}"),
            Err(_) => Ok(Vec::new()),
        }
    }

    fn read_line(&mut self) -> io::Result<Option<String>> {
        self.lines.next_line()
    }

    fn discard_pending(&mut self) -> io::Result<()> {
        Ok(())
    }

    fn suspend(&mut self) -> io::Result<()> {
        self.written.push_str("<suspended>");

        if let Some(Step::Columns(columns)) = self.steps.front() {
            self.columns = *columns;
            self.steps.pop_front();
        }

        Ok(())
    }

    fn write(&mut self, text: &str) -> io::Result<()> {
        self.written.push_str(text);
        Ok(())
    }

    fn write_error(&mut self, text: &str) -> io::Result<()> {
        self.written.push_str(text);
        Ok(())
    }
}

fn key_event(name: &str) -> KeyEvent {
    let plain = |code| KeyEvent::new(code, KeyModifiers::NONE);
    let with = |code, modifiers| KeyEvent::new(code, modifiers);

    match name {
        "up" => plain(KeyCode::Up),
        "down" => plain(KeyCode::Down),
        "right" => plain(KeyCode::Right),
        "left" => plain(KeyCode::Left),
        "home" => plain(KeyCode::Home),
        "end" => plain(KeyCode::End),
        "delete" => plain(KeyCode::Delete),
        "insert" => plain(KeyCode::Insert),
        "pageup" => plain(KeyCode::PageUp),
        "f5" => plain(KeyCode::F(5)),
        "backspace" => plain(KeyCode::Backspace),
        "enter" | "newline" => plain(KeyCode::Enter),
        "tab" => plain(KeyCode::Tab),
        "shift-tab" => with(KeyCode::BackTab, KeyModifiers::SHIFT),
        "shift-left" => with(KeyCode::Left, KeyModifiers::SHIFT),
        "shift-delete" => with(KeyCode::Delete, KeyModifiers::SHIFT),
        "alt-enter" => with(KeyCode::Enter, KeyModifiers::ALT),
        "ctrl-up" => with(KeyCode::Up, KeyModifiers::CONTROL),
        "ctrl-end" => with(KeyCode::End, KeyModifiers::CONTROL),
        "ctrl-left" => with(KeyCode::Left, KeyModifiers::CONTROL),
        "ctrl-right" => with(KeyCode::Right, KeyModifiers::CONTROL),
        "ctrl-delete" => with(KeyCode::Delete, KeyModifiers::CONTROL),
        "ctrl-backspace" => with(KeyCode::Backspace, KeyModifiers::CONTROL),
        "ctrl-shift-delete" => with(KeyCode::Delete, KeyModifiers::CONTROL | KeyModifiers::SHIFT),
        "ctrl-shift-left" => with(KeyCode::Left, KeyModifiers::CONTROL | KeyModifiers::SHIFT),
        "ctrl-shift-backspace" => with(
            KeyCode::Backspace,
            KeyModifiers::CONTROL | KeyModifiers::SHIFT,
        ),
        "ctrl-alt-left" => with(KeyCode::Left, KeyModifiers::CONTROL | KeyModifiers::ALT),
        "ctrl-alt-right" => with(KeyCode::Right, KeyModifiers::CONTROL | KeyModifiers::ALT),
        "ctrl-alt-delete" => with(KeyCode::Delete, KeyModifiers::CONTROL | KeyModifiers::ALT),
        "alt-left" => with(KeyCode::Left, KeyModifiers::ALT),
        "alt-delete" => with(KeyCode::Delete, KeyModifiers::ALT),
        "alt-backspace" => with(KeyCode::Backspace, KeyModifiers::ALT),
        "alt-ctrl-h" => with(
            KeyCode::Char('h'),
            KeyModifiers::CONTROL | KeyModifiers::ALT,
        ),
        "alt-ctrl-a" => with(
            KeyCode::Char('a'),
            KeyModifiers::CONTROL | KeyModifiers::ALT,
        ),
        "alt-ctrl-y" => with(
            KeyCode::Char('y'),
            KeyModifiers::CONTROL | KeyModifiers::ALT,
        ),
        "alt-ctrl-undo" => with(
            KeyCode::Char('7'),
            KeyModifiers::CONTROL | KeyModifiers::ALT,
        ),
        "ctrl-undo" => with(KeyCode::Char('7'), KeyModifiers::CONTROL),
        "ctrl-redo" => with(KeyCode::Char('6'), KeyModifiers::CONTROL),
        "ctrl-backslash" => with(KeyCode::Char('4'), KeyModifiers::CONTROL),
        "ctrl-bracket" => with(KeyCode::Char('5'), KeyModifiers::CONTROL),
        "alt-B" | "alt-F" | "alt-D" | "alt-Y" => with(
            KeyCode::Char(name.chars().last().unwrap()),
            KeyModifiers::ALT | KeyModifiers::SHIFT,
        ),
        _ => {
            if let Some(letter) = name.strip_prefix("ctrl-") {
                return with(
                    KeyCode::Char(letter.chars().next().unwrap()),
                    KeyModifiers::CONTROL,
                );
            }

            if let Some(letter) = name.strip_prefix("alt-") {
                return with(
                    KeyCode::Char(letter.chars().next().unwrap()),
                    KeyModifiers::ALT,
                );
            }

            let mut characters = name.chars();
            let character = characters.next().unwrap();

            assert!(characters.next().is_none(), "unknown key {name:?}");

            if character.is_uppercase() {
                with(KeyCode::Char(character), KeyModifiers::SHIFT)
            } else {
                plain(KeyCode::Char(character))
            }
        }
    }
}

fn steps_of(entry: &Value) -> (VecDeque<Step>, Vec<u8>) {
    let kind = text(entry, "kind");
    let terminal = entry["outputTerminal"].as_bool().unwrap();
    let mut steps = VecDeque::new();
    let mut piped = Vec::new();
    let keys: Vec<&Value> = entry["keys"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|key| match key.get("repeat") {
            Some(times) => {
                let inner = key["keys"].as_array().unwrap();

                (0..times.as_u64().unwrap())
                    .flat_map(|_| inner.iter())
                    .collect()
            }
            None => vec![key],
        })
        .collect();

    for key in keys {
        if let Some(columns) = key.get("columns") {
            let columns = columns.as_u64().map(|value| u16::try_from(value).unwrap());

            steps.push_back(Step::Columns(columns));
        } else if let Some(bytes) = key.get("bytes") {
            let bytes = bytes
                .as_array()
                .unwrap()
                .iter()
                .map(|byte| u8::try_from(byte.as_u64().unwrap()).unwrap())
                .collect();

            steps.push_back(Step::Chunk(bytes));
        } else if !terminal {
            piped.extend_from_slice(key.as_str().unwrap().as_bytes());
        } else if kind == "hidden" {
            steps.push_back(Step::Chunk(key.as_str().unwrap().as_bytes().to_vec()));
        } else {
            steps.push_back(Step::Key(key_event(key.as_str().unwrap())));
        }
    }

    (steps, piped)
}

#[test]
fn the_terminal_prompts_write_what_the_js_writes() {
    let fixture = fixture();

    for entry in list(&fixture, "sessions") {
        let name = text(entry, "name");
        let terminal = entry["outputTerminal"].as_bool().unwrap();
        let (steps, piped) = steps_of(entry);
        let dumb = entry["env"]["TERM"].as_str() == Some("dumb");
        let console = Scripted {
            steps,
            lines: LineReader::new(Cursor::new(piped)),
            columns: entry["columns"]
                .as_u64()
                .map(|value| u16::try_from(value).unwrap()),
            output_terminal: terminal,
            written: String::new(),
            raw: Vec::new(),
        };
        let mut prompter = TerminalPrompter::new(console, colors(&entry["env"], terminal), dumb);
        let messages = messages(text(entry, "locale"));
        let prompt = text(entry, "text");

        match text(entry, "kind") {
            "select" => {
                let answer = prompter.select(
                    prompt,
                    &views(&entry["choices"]),
                    usize::try_from(entry["index"].as_u64().unwrap()).unwrap(),
                    messages,
                );

                check_outcome(
                    name,
                    answer.map(|index| u64::try_from(index).unwrap()),
                    entry,
                );
            }
            "line" => check_outcome(name, prompter.line(prompt, messages), entry),
            _ => check_outcome(name, prompter.hidden(prompt, messages), entry),
        }

        assert!(prompter.interactive(), "{name}");
        assert_eq!(prompter.console().written, text(entry, "written"), "{name}");

        let raw: Vec<bool> = entry["raw"]
            .as_array()
            .unwrap()
            .iter()
            .map(|mode| mode.as_bool().unwrap())
            .collect();

        assert_eq!(prompter.console().raw, raw, "{name}");
    }
}

fn input_of(entry: &Value) -> Vec<u8> {
    entry["input"].as_str().map_or_else(
        || {
            entry["input"]["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|byte| u8::try_from(byte.as_u64().unwrap()).unwrap())
                .collect()
        },
        |input| input.as_bytes().to_vec(),
    )
}

#[test]
fn without_a_terminal_each_question_takes_the_next_piped_line() {
    let fixture = fixture();

    for entry in list(&fixture, "pipes") {
        let name = text(entry, "name");
        let mut prompter = PipedPrompter::new(
            Cursor::new(input_of(entry)),
            Vec::new(),
            Vec::new(),
            Colors::default(),
        );
        let calls = entry["calls"].as_array().unwrap();
        let answers = entry["answers"].as_array().unwrap();

        for (position, (method, expected)) in calls.iter().zip(answers).enumerate() {
            let prompt = format!("Q{position}: ");
            let answer = if method == "hidden" {
                prompter.hidden(&prompt, &EN_US)
            } else {
                prompter.line(&prompt, &EN_US)
            };

            check_outcome(name, answer, expected);
        }

        assert!(!prompter.interactive(), "{name}");
        prompter.close();

        let (out, err) = prompter.into_parts();

        assert_eq!(
            String::from_utf8(out).unwrap(),
            text(entry, "written"),
            "{name}"
        );
        assert!(err.is_empty(), "{name}");
    }
}

fn reply_of(reply: &Value) -> Reply {
    match reply {
        Value::String(word) => match word.as_str() {
            "cancel" => Reply::Cancel,
            "end" => Reply::End,
            "fail" => Reply::Fail(io::ErrorKind::Other),
            "last" => Reply::Last,
            _ => Reply::Default,
        },
        _ => reply.get("text").and_then(Value::as_str).map_or_else(
            || Reply::Choose(usize::try_from(reply["choose"].as_u64().unwrap()).unwrap()),
            |typed| Reply::Text(typed.to_owned()),
        ),
    }
}

fn fake_of(entry: &Value) -> FakePrompter {
    let mut replies: Vec<Reply> = entry["replies"]
        .as_array()
        .unwrap()
        .iter()
        .map(reply_of)
        .collect();
    let calls = entry["calls"].as_array().unwrap();

    for call in calls.iter().skip(replies.len()) {
        replies.push(if call["kind"] == "select" {
            Reply::Default
        } else {
            Reply::Text(String::new())
        });
    }

    replies.push(Reply::End);

    FakePrompter::new(entry["interactive"].as_bool().unwrap())
        .with_colors(colors(&entry["env"], false))
        .with_replies(replies)
}

fn call_json(call: &FakeCall) -> Value {
    match call {
        FakeCall::Line { prompt } => json!({ "kind": "line", "prompt": prompt }),
        FakeCall::Hidden { prompt } => json!({ "kind": "hidden", "prompt": prompt }),
        FakeCall::Select {
            title,
            choices,
            index,
        } => json!({
            "kind": "select",
            "title": title,
            "choices": choices.iter().map(|choice| json!({
                "label": choice.label,
                "hint": choice.hint,
                "heading": choice.heading,
                "previous": choice.previous,
            })).collect::<Vec<_>>(),
            "index": index,
        }),
    }
}

fn check_calls(name: &str, fake: &FakePrompter, entry: &Value) {
    let calls: Vec<Value> = fake.calls().iter().map(call_json).collect();

    assert_eq!(Value::Array(calls), entry["calls"], "{name}");
}

#[test]
fn guard_cancel_asks_to_leave_like_the_js() {
    let fixture = fixture();
    let choices = views(&json!([
        { "label": "off" },
        { "label": "base", "hint": "fastest" },
        { "label": "medium", "hint": "most accurate" },
    ]));

    for entry in list(&fixture, "guards") {
        let name = text(entry, "name");
        let mut fake = fake_of(entry);
        let mut guard = GuardCancel::new(&mut fake);

        assert_eq!(guard.interactive(), entry["interactive"].as_bool().unwrap());
        assert_eq!(guard.colors(), colors(&entry["env"], false));

        match text(entry, "method") {
            "line" => check_outcome(name, guard.line("Minutes? ", &EN_US), entry),
            "hidden" => check_outcome(name, guard.hidden("Minutes? ", &EN_US), entry),
            _ => {
                let answer = guard.select("Model?", &choices, 1, &EN_US);

                check_outcome(
                    name,
                    answer.map(|index| u64::try_from(index).unwrap()),
                    entry,
                );
            }
        }

        guard.report("x").unwrap();
        guard.close();
        assert!(format!("{guard:?}").contains("GuardCancel"));
        assert!(fake.closed(), "{name}");
        assert_eq!(fake.reports(), ["x"], "{name}");
        check_calls(name, &fake, entry);
    }
}

fn item_of(choice: &Value) -> ChoiceItem<Value> {
    if choice["heading"].as_bool().unwrap() {
        return ChoiceItem::heading(text(choice, "label"));
    }

    let aliases: Vec<&str> = choice["aliases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|alias| alias.as_str().unwrap())
        .collect();

    ChoiceItem::Pick {
        label: text(choice, "label").to_owned(),
        hint: choice["hint"].as_str().map(str::to_owned),
        previous: choice["previous"].as_bool().unwrap(),
        answer: text(choice, "answer").to_owned(),
        aliases: aliases.iter().map(|alias| (*alias).to_owned()).collect(),
        value: choice["value"].clone(),
    }
}

fn parse_minutes(typed: &str) -> Option<Value> {
    let minutes = js_number(&bcct::js::js_trim(typed).replacen(',', ".", 1));

    (!bcct::js::js_trim(typed).is_empty() && minutes.is_finite() && minutes > 0.0)
        .then(|| json!(minutes))
}

fn parse_days(typed: &str) -> Option<Value> {
    (!typed.is_empty() && typed.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| js_number(typed))
        .filter(|days| *days > 0.0)
        .map(|days| json!(days))
}

#[test]
fn ask_choice_asks_and_validates_like_the_js() {
    let fixture = fixture();

    for entry in list(&fixture, "choices") {
        let name = text(entry, "name");
        let messages = messages(text(entry, "locale"));
        let spec = &entry["spec"];
        let other_spec = &spec["other"];
        let parse: &dyn Fn(&str) -> Option<Value> = if other_spec["parse"] == "days" {
            &parse_days
        } else {
            &parse_minutes
        };
        let custom_prompt = other_spec["prompt"].as_str().unwrap_or_default().to_owned();
        let custom_hint = other_spec["hint"].as_str().unwrap_or_default().to_owned();
        let mut ask_custom = |ask: &mut dyn Prompter| {
            ask_validated(&custom_prompt, parse, &custom_hint, messages, ask)
        };
        let other = other_spec.as_object().map(|_| Other {
            label: text(other_spec, "label").to_owned(),
            answer: text(other_spec, "answer").to_owned(),
            parse,
            ask_on_terminal: &mut ask_custom,
        });
        let question = ChoiceQuestion {
            title: text(spec, "title").to_owned(),
            choices: spec["choices"]
                .as_array()
                .unwrap()
                .iter()
                .map(item_of)
                .collect(),
            index: usize::try_from(spec["index"].as_u64().unwrap()).unwrap(),
            other,
            default_hint: (spec["defaultHint"] == "language")
                .then_some(messages.language_default_hint),
        };
        let mut fake = fake_of(entry);

        assert_eq!(
            format!("{question:?}").contains("Other"),
            other_spec.is_object()
        );

        check_outcome(name, ask_choice(question, messages, &mut fake), entry);
        check_calls(name, &fake, entry);

        let reports: Vec<Value> = fake.reports().iter().map(|line| json!(line)).collect();

        assert_eq!(Value::Array(reports), entry["reports"], "{name}");
    }
}

fn spec_items(entry: &Value) -> Vec<ChoiceItem<Value>> {
    entry["spec"]["choices"]
        .as_array()
        .unwrap()
        .iter()
        .map(item_of)
        .collect()
}

fn number_value(number: f64) -> Value {
    let shown = bcct::js::format_number(number);

    shown
        .parse::<i64>()
        .map_or_else(|_| json!(number), |whole| json!(whole))
}

fn as_values(items: Vec<ChoiceItem<f64>>) -> Vec<ChoiceItem<Value>> {
    items
        .into_iter()
        .map(|item| match item {
            ChoiceItem::Heading(label) => ChoiceItem::Heading(label),
            ChoiceItem::Pick {
                label,
                hint,
                previous,
                answer,
                aliases,
                value,
            } => ChoiceItem::Pick {
                label,
                hint,
                previous,
                answer,
                aliases,
                value: number_value(value),
            },
        })
        .collect()
}

#[test]
fn number_choices_and_marks_build_the_choices_of_the_js() {
    let fixture = fixture();

    for entry in list(&fixture, "choices") {
        let domain = text(entry, "domain");
        let messages = messages(text(entry, "locale"));
        let saved = entry["options"]["saved"].as_bool().unwrap_or(false);
        let expected = spec_items(entry);

        let built = match domain {
            "delay" => {
                let current = entry["current"].as_f64();
                let options = number_choices(&DELAY_PRESETS, current, &|minutes| {
                    (messages.delay_label)(minutes)
                });
                let index = index_of_value(&options, &current.unwrap());
                let recommended = messages.recommended.to_owned();

                as_values(marked(
                    options,
                    index,
                    saved,
                    &|choice| {
                        if choice.value() == Some(&RECOMMENDED_DELAY) {
                            vec![recommended.clone()]
                        } else {
                            Vec::new()
                        }
                    },
                    messages,
                ))
            }
            "inbox" => {
                let current = entry["current"].as_f64();
                let label = |days: f64| {
                    (messages.inbox_days_label)(bcct::js::format_number(days).parse().unwrap())
                };
                let mut options = as_values(number_choices(&INBOX_PRESETS, current, &label));
                let forever = expected.last().unwrap().clone();
                let forever = match forever {
                    ChoiceItem::Pick {
                        hint,
                        answer,
                        aliases,
                        value,
                        ..
                    } => ChoiceItem::Pick {
                        label: messages.inbox_forever_label.to_owned(),
                        hint,
                        previous: false,
                        answer,
                        aliases,
                        value,
                    },
                    ChoiceItem::Heading(label) => ChoiceItem::Heading(label),
                };

                options.push(forever);

                let index = index_of_value(&options, &entry["current"]);

                marked(options, index, saved, &|_| Vec::new(), messages)
            }
            _ => continue,
        };

        assert_eq!(built, expected, "{}", text(entry, "name"));
    }
}

const ZERO_WIDTH: [(u32, u32); 8] = [
    (0x0, 0x1f),
    (0x7f, 0x9f),
    (0x300, 0x36f),
    (0x200b, 0x200f),
    (0x20d0, 0x20ff),
    (0xfe00, 0xfe0f),
    (0xfe20, 0xfe2f),
    (0xe0100, 0xe01ef),
];
const FULL_WIDTH: [(u32, u32); 16] = [
    (0x1100, 0x115f),
    (0x2329, 0x2329),
    (0x232a, 0x232a),
    (0x2e80, 0x303e),
    (0x3040, 0x3247),
    (0x3250, 0x4dbf),
    (0x4e00, 0xa4c6),
    (0xa960, 0xa97c),
    (0xac00, 0xd7a3),
    (0xf900, 0xfaff),
    (0xfe10, 0xfe19),
    (0xfe30, 0xfe6b),
    (0xff01, 0xff60),
    (0xffe0, 0xffe6),
    (0x1b000, 0x1b001),
    (0x1f000, 0x10_ffff),
];

fn width_in_table(code: u32) -> u64 {
    let inside = |ranges: &[(u32, u32)]| {
        ranges
            .iter()
            .any(|(low, high)| (*low..=*high).contains(&code))
    };

    if inside(&ZERO_WIDTH) {
        0
    } else if inside(&FULL_WIDTH) {
        2
    } else {
        1
    }
}

#[test]
fn display_width_follows_the_table_node_uses_without_icu_with_emoji_wide() {
    for (low, high) in ZERO_WIDTH.iter().chain(&FULL_WIDTH) {
        for code in [low.wrapping_sub(1), *low, *high, high + 1] {
            if let Some(character) = char::from_u32(code) {
                assert_eq!(
                    bcct::prompt::display_width(character),
                    width_in_table(code),
                    "{code:#x}"
                );
            }
        }
    }
}

#[test]
fn number_choices_find_the_current_value_like_includes() {
    let label = |value: f64| format!("{value}");
    let answers = |choices: Vec<ChoiceItem<f64>>| -> Vec<String> {
        choices
            .iter()
            .map(|choice| choice.label().to_owned())
            .collect()
    };

    assert_eq!(
        answers(number_choices(&[1.0], Some(f64::NAN), &label)),
        ["1", "NaN"]
    );
    assert_eq!(
        answers(number_choices(&[f64::NAN], Some(f64::NAN), &label)),
        ["NaN"]
    );
    assert_eq!(
        answers(number_choices(&[0.0, 2.0], Some(-0.0), &label)),
        ["0", "2"]
    );
    assert_eq!(
        answers(number_choices(&[3.0, 1.0], Some(2.0), &label)),
        ["1", "2", "3"]
    );
    assert_eq!(
        answers(number_choices(&[3.0, 1.0], None, &label)),
        ["3", "1"]
    );
}

#[test]
fn ask_yes_no_matches_the_js() {
    let fixture = fixture();

    for entry in list(&fixture, "yesNos") {
        let name = text(entry, "name");
        let mut fake = fake_of(entry);
        let answer = ask_yes_no(
            "Go on?",
            &EN_US,
            entry["defaultYes"].as_bool().unwrap(),
            &mut fake,
        );

        check_outcome(name, answer, entry);
        check_calls(name, &fake, entry);
    }
}

#[test]
fn each_error_says_what_happened_and_what_kind_it_is() {
    let cancelled = PromptError::Cancelled(EN_US.cancelled);
    let interrupted = PromptError::Interrupted(EN_US.interrupted);
    let ended = PromptError::Ended(EN_US.cancelled);
    let aborted = PromptError::Aborted(bcct::prompt::CTRL_D_ABORT);
    let failed = PromptError::from(io::Error::other("disk"));

    assert_eq!(cancelled.to_string(), "Cancelled.");
    assert_eq!(interrupted.to_string(), "Setup interrupted.");
    assert_eq!(ended.to_string(), "Cancelled.");
    assert_eq!(aborted.to_string(), "Aborted with Ctrl+D");
    assert_eq!(failed.to_string(), "disk");
    assert!(cancelled.is_cancelled() && !cancelled.is_interrupted());
    assert!(interrupted.is_interrupted() && !interrupted.is_cancelled());
    assert!(!ended.is_cancelled() && !ended.is_interrupted());
    assert!(matches!(failed, PromptError::Io(_)));
}

#[test]
fn choices_and_their_items_build_the_lines_of_a_selection() {
    let heading = Choice::heading("Installed:");
    let plain = Choice::new("off");
    let empty_hint = Choice {
        hint: Some(String::new()),
        ..Choice::new("x")
    };
    let item = ChoiceItem::pick("base", "b", 1)
        .with_hint("fastest")
        .with_aliases(&["1", "one"]);
    let group: ChoiceItem<i32> = ChoiceItem::heading("Group")
        .with_hint("h")
        .with_aliases(&["z"]);

    assert!(heading.heading && !heading.previous && heading.label == "Installed:");
    assert!(!plain.heading && plain.shown_hint().is_none());
    assert!(empty_hint.shown_hint().is_none());
    assert_eq!(item.label(), "base");
    assert_eq!(item.value(), Some(&1));
    assert_eq!(
        item.choice(),
        Choice {
            label: "base".to_owned(),
            hint: Some("fastest".to_owned()),
            heading: false,
            previous: false,
        }
    );
    assert_eq!(group.label(), "Group");
    assert_eq!(group.value(), None);
    assert_eq!(group.choice(), Choice::heading("Group"));

    let tagged = marked(
        vec![group, item],
        1,
        true,
        &|_| vec!["new".to_owned()],
        &EN_US,
    );

    assert_eq!(tagged[0].label(), "Group (new)");
    assert_eq!(tagged[1].label(), "base (new, previously chosen)");
    assert!(tagged[1].choice().previous);
}

#[test]
fn a_selection_of_a_heading_or_of_nothing_has_no_value() {
    let question = |index| ChoiceQuestion {
        title: "Pick".to_owned(),
        choices: vec![ChoiceItem::heading("Group"), ChoiceItem::pick("a", "a", 1)],
        index,
        other: None,
        default_hint: None,
    };
    let mut picked = FakePrompter::new(true).with_replies([Reply::Choose(0)]);
    let mut typed = FakePrompter::new(false);

    assert!(matches!(
        ask_choice(question(1), &EN_US, &mut picked),
        Err(PromptError::Io(_))
    ));
    assert!(matches!(
        ask_choice(question(0), &EN_US, &mut typed),
        Err(PromptError::Io(_))
    ));
    assert_eq!(
        typed.calls(),
        [FakeCall::Line {
            prompt: "Pick (a) [default: undefined]: ".to_owned()
        }]
    );
}

#[test]
fn a_hidden_question_is_styled_like_the_others() {
    let mut fake = FakePrompter::new(true)
        .with_colors(Colors {
            out: true,
            err: false,
        })
        .with_replies([Reply::Text("123:abc".to_owned())]);

    assert_eq!(
        bcct::prompt::ask_hidden("Token: ", &EN_US, &mut fake).unwrap(),
        "123:abc"
    );
    assert_eq!(
        fake.calls(),
        [FakeCall::Hidden {
            prompt: "\u{1b}[1mToken: \u{1b}[22m".to_owned()
        }]
    );
}

#[test]
fn the_fake_answers_in_order_and_refuses_an_answer_of_the_wrong_kind() {
    let mut fake = FakePrompter::new(true);

    fake.push_reply(Reply::Choose(1));
    fake.push_reply(Reply::Text("x".to_owned()));
    fake.push_reply(Reply::Fail(io::ErrorKind::BrokenPipe));
    fake.push_reply(Reply::End);
    fake.push_reply(Reply::Last);

    let choices = [Choice::new("a"), Choice::new("b")];

    assert!(matches!(fake.line("L", &EN_US), Err(PromptError::Io(_))));
    assert!(matches!(
        fake.select("S", &choices, 0, &EN_US),
        Err(PromptError::Io(_))
    ));
    assert!(matches!(
        fake.hidden("H", &EN_US),
        Err(PromptError::Io(error)) if error.kind() == io::ErrorKind::BrokenPipe
    ));
    assert!(matches!(
        fake.select("S", &choices, 0, &EN_US),
        Err(PromptError::Ended(_))
    ));
    assert_eq!(fake.select("S", &choices, 0, &EN_US).unwrap(), 1);
    assert_eq!(fake.select("S", &[], 0, &EN_US).unwrap(), 0);
    assert_eq!(fake.line("L", &EN_US).unwrap(), "");
    assert!(!fake.closed());
}

#[test]
fn without_a_terminal_there_is_no_selection_and_errors_go_to_stderr() {
    let mut prompter = PipedPrompter::new(
        Cursor::new(Vec::new()),
        Vec::new(),
        Vec::new(),
        Colors {
            out: true,
            err: true,
        },
    );

    assert_eq!(
        prompter.colors(),
        Colors {
            out: true,
            err: true
        }
    );
    assert!(matches!(
        prompter.select("S", &[Choice::new("a")], 0, &EN_US),
        Err(PromptError::Io(error)) if error.kind() == io::ErrorKind::Unsupported
    ));
    prompter.report("bad").unwrap();

    let (out, err) = prompter.into_parts();

    assert_eq!(out, b"");
    assert_eq!(err, b"bad\n");
}

#[test]
fn the_prompter_of_the_process_depends_on_whether_stdin_is_a_terminal() {
    use std::io::IsTerminal;

    let var = |name: &str| (name == "NO_COLOR").then(|| OsString::from("1"));
    let mut prompter = bcct::prompt::create_prompter(&var);

    assert_eq!(prompter.interactive(), io::stdin().is_terminal());
    assert_eq!(prompter.colors(), Colors::default());
    assert_eq!(Colors::of_process(&var), Colors::default());
    prompter.close();
}

fn scripted(steps: Vec<Step>) -> TerminalPrompter<Scripted> {
    TerminalPrompter::new(
        Scripted {
            steps: steps.into(),
            lines: LineReader::new(Cursor::new(Vec::new())),
            columns: None,
            output_terminal: true,
            written: String::new(),
            raw: Vec::new(),
        },
        Colors::default(),
        false,
    )
}

#[test]
fn a_terminal_that_fails_or_ends_gives_the_terminal_back() {
    let mut line = scripted(vec![Step::Key(key_event("a"))]);
    let mut hidden = scripted(vec![Step::Chunk(b"ab".to_vec())]);
    let mut choose = scripted(Vec::new());

    assert!(matches!(line.line("Q? ", &EN_US), Err(PromptError::Io(_))));
    assert_eq!(line.console().raw, [true, false]);
    assert_eq!(line.console().written, "\u{1b}[1G\u{1b}[0JQ? \u{1b}[4Ga");
    assert!(matches!(
        hidden.hidden("T: ", &PT_BR),
        Err(PromptError::Ended("Cancelado."))
    ));
    assert_eq!(hidden.console().raw, [true, false]);
    assert_eq!(hidden.console().written, "T: \n");
    assert!(matches!(
        choose.select("S", &[Choice::new("a")], 0, &EN_US),
        Err(PromptError::Io(_))
    ));
    assert_eq!(choose.console().raw, [true, false]);
    choose.report("oops").unwrap();
    assert!(choose.console().written.ends_with("oops\n"));
}

#[test]
fn a_suspended_question_gives_the_terminal_back_and_redraws_with_the_size_it_finds() {
    let mut prompter = scripted(vec![
        Step::Key(key_event("a")),
        Step::Key(key_event("ctrl-z")),
        Step::Columns(Some(3)),
        Step::Key(key_event("enter")),
    ]);

    assert_eq!(prompter.line("Q? ", &EN_US).unwrap(), "a");
    assert_eq!(prompter.console().raw, [true, false, true, false]);
    assert_eq!(
        prompter.console().written,
        "\u{1b}[1G\u{1b}[0JQ? \u{1b}[4Ga<suspended>\u{1b}[1G\u{1b}[0JQ? a\u{1b}[2G\r\n"
    );
}

#[test]
fn ctrl_z_does_nothing_in_a_selection() {
    let mut prompter = scripted(vec![
        Step::Key(key_event("ctrl-z")),
        Step::Key(key_event("enter")),
    ]);

    assert_eq!(
        prompter
            .select("S", &[Choice::new("a")], 0, &EN_US)
            .unwrap(),
        0
    );
    assert_eq!(prompter.console().raw, [true, false]);
    assert!(!prompter.console().written.contains("<suspended>"));
}

#[test]
fn a_selection_without_choices_ignores_the_keys_until_ctrl_c() {
    let mut prompter = scripted(vec![
        Step::Key(key_event("down")),
        Step::Key(key_event("up")),
        Step::Key(key_event("enter")),
        Step::Key(key_event("ctrl-c")),
    ]);

    assert!(matches!(
        prompter.select("S", &[], 0, &EN_US),
        Err(PromptError::Cancelled(_))
    ));
    assert_eq!(prompter.console().raw, [true, false]);
}

#[test]
fn a_line_without_a_terminal_output_ends_with_the_input() {
    let mut prompter = TerminalPrompter::new(
        Scripted {
            steps: VecDeque::new(),
            lines: LineReader::new(Cursor::new(Vec::new())),
            columns: None,
            output_terminal: false,
            written: String::new(),
            raw: Vec::new(),
        },
        Colors::default(),
        false,
    );

    assert!(matches!(
        prompter.line("Q? ", &EN_US),
        Err(PromptError::Ended(_))
    ));
    assert_eq!(prompter.console().written, "Q? ");
    assert_eq!(prompter.console().raw, Vec::<bool>::new());
}
