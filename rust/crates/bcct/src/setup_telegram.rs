use std::fmt::Write as _;
use std::io;
use std::path::Path;

use serde_json::{Map, Value, json};

use crate::files::{FileFailure, create_private_dir, read_json, write_private};
use crate::health::Screen;
use crate::journal::link_target;
use crate::js::{
    join_path, js_number, js_string, js_template, js_trim, js_truthy, stringify_pretty,
};
use crate::messages::Messages;
use crate::setup::{ACCESS_FILE, ENV_FILE, SETUP_COMMAND, is_paired, parse_env_token, read_text};
use crate::spinner::{Pending, pending};
use crate::telegram::{Fetch, call, property};
use crate::ui::{bold, link, skipped, success, warn};

pub const PAIRING_TIMEOUT_MS: u64 = 180_000;

const PAIRING_CODE_BYTES: usize = 4;
const LONG_POLL_SECONDS: u64 = 30;
const ALLOWLIST: &str = "allowlist";
const PRIVATE_CHAT: &str = "private";
const START_COMMAND: &str = "/start";
const UNDEFINED: &str = "undefined";
const TEXT_NOT_TRIMMABLE: &str = "update.message.text?.trim is not a function";
const REPLACEMENT: char = '\u{fffd}';
const NO_RANDOM_BYTES: &str = "Could not generate the pairing code.";

pub struct TelegramSetup<'a> {
    pub state_dir: &'a Path,
    pub messages: &'static Messages,
    pub fetch: Fetch<'a>,
    pub api_root: &'a str,
    pub now: &'a dyn Fn() -> u64,
    pub random: &'a dyn Fn(usize) -> Option<Vec<u8>>,
    pub is_running: &'a dyn Fn(&Path) -> Option<String>,
}

impl std::fmt::Debug for TelegramSetup<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TelegramSetup")
            .field("state_dir", &self.state_dir)
            .field("api_root", &self.api_root)
            .finish_non_exhaustive()
    }
}

impl TelegramSetup<'_> {
    fn call(&self, token: &str, method: &str, params: &Value) -> Result<Option<Value>, String> {
        call(
            self.fetch,
            self.api_root,
            token,
            method,
            params,
            self.messages,
        )
    }

    fn saved_token(&self) -> Option<String> {
        parse_env_token(&read_text(&join_path(self.state_dir, ENV_FILE)).unwrap_or_default())
            .filter(|token| !token.is_empty())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedBot {
    pub token: String,
    pub username: String,
    pub can_join_groups: bool,
    pub screen_refused: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub user_id: String,
    pub label: Option<Value>,
    pub update_id: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingChoice {
    Keep,
    Replace,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    Failed(String),
    Screen,
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

pub trait Prompts {
    type Error: From<Failure>;

    fn yes_no(&mut self, prompt: &str) -> Result<bool, Self::Error>;
    fn hidden(&mut self, prompt: &str) -> Result<String, Self::Error>;
    fn pairing_choice(&mut self, accounts: &str) -> Result<PairingChoice, Self::Error>;
}

pub trait Tracks {
    fn track_dir(&mut self, dir: &Path);
    fn track_file(&mut self, file: &Path) -> io::Result<()>;
}

fn undefined_or(value: Option<&Value>) -> String {
    value.map_or_else(|| UNDEFINED.to_owned(), js_template)
}

fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value
        .and_then(Value::as_object)
        .and_then(|object| object.get(key))
}

fn number(value: f64) -> Value {
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

fn to_number(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Object(_)) => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(other) => js_number(&js_string(other)),
    }
}

fn js_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else {
        left.max(right)
    }
}

fn plus_one(value: Option<&Value>) -> Value {
    match value {
        Some(text @ (Value::String(_) | Value::Array(_) | Value::Object(_))) => {
            Value::String(format!("{}1", js_string(text)))
        }
        other => number(to_number(other) + 1.0),
    }
}

fn spread(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(object) => object.clone(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, item)| (index.to_string(), item.clone()))
            .collect(),
        Value::String(text) => text
            .encode_utf16()
            .enumerate()
            .map(|(index, unit)| {
                let character = char::from_u32(u32::from(unit)).unwrap_or(REPLACEMENT);
                (index.to_string(), Value::String(character.to_string()))
            })
            .collect(),
        _ => Map::new(),
    }
}

#[must_use]
pub fn build_access(current: Option<&Value>, user_id: &str) -> Value {
    let mut access = current.map(spread).unwrap_or_default();

    access.insert("dmPolicy".to_owned(), json!(ALLOWLIST));
    access.insert("allowFrom".to_owned(), json!([user_id]));
    access.insert("groups".to_owned(), json!({}));
    access.insert("pending".to_owned(), json!({}));

    Value::Object(access)
}

#[must_use]
pub fn pairing_code(random: &dyn Fn(usize) -> Option<Vec<u8>>) -> Option<String> {
    random(PAIRING_CODE_BYTES).map(|bytes| {
        bytes.iter().fold(String::new(), |mut hex, byte| {
            let _written = write!(hex, "{byte:02x}");
            hex
        })
    })
}

#[must_use]
pub fn random_bytes(count: usize) -> Option<Vec<u8>> {
    let mut bytes = vec![0; count];

    getrandom::fill(&mut bytes).ok().map(|()| bytes)
}

#[must_use]
pub fn pairing_link(username: &str, code: &str) -> String {
    format!("https://t.me/{username}?start={code}")
}

fn listed<'a>(updates: Option<&'a Value>, method: &str) -> Result<&'a [Value], String> {
    property(updates, method)?;

    updates
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| format!("updates.{method} is not a function"))
}

fn candidate_from(update: &Value, from: &Value) -> Candidate {
    let username = field(Some(from), "username").filter(|username| js_truthy(username));

    Candidate {
        user_id: undefined_or(field(Some(from), "id")),
        label: username.map_or_else(
            || field(Some(from), "first_name").cloned(),
            |username| Some(Value::String(format!("@{}", js_template(username)))),
        ),
        update_id: field(Some(update), "update_id").cloned(),
    }
}

pub fn find_pairing_candidate(
    updates: Option<&Value>,
    code: &str,
) -> Result<Option<Candidate>, String> {
    let start = format!("{START_COMMAND} {code}");

    for update in listed(updates, "find")? {
        let message = property(Some(update), "message")?;

        if field(field(message, "chat"), "type").and_then(Value::as_str) != Some(PRIVATE_CHAT) {
            continue;
        }

        let Some(from) = field(message, "from").filter(|from| js_truthy(from)) else {
            continue;
        };
        let text = match field(message, "text") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => Some(js_trim(text)),
            Some(_) => return Err(TEXT_NOT_TRIMMABLE.to_owned()),
        };

        if text.is_some_and(|text| text == code || text == start) {
            return Ok(Some(candidate_from(update, from)));
        }
    }

    Ok(None)
}

pub fn last_update_id(updates: Option<&Value>) -> Result<f64, String> {
    listed(updates, "reduce")?
        .iter()
        .try_fold(-1.0, |highest, update| {
            Ok(js_max(
                highest,
                to_number(property(Some(update), "update_id")?),
            ))
        })
}

pub fn saved_bot(token: &str, bot: Option<&Value>) -> Result<SavedBot, String> {
    let username = undefined_or(property(bot, "username")?);
    let can_join_groups = property(bot, "can_join_groups")? == Some(&Value::Bool(true));

    Ok(SavedBot {
        token: token.to_owned(),
        username,
        can_join_groups,
        screen_refused: false,
    })
}

#[must_use]
pub fn groups_warning(bot: &SavedBot, messages: &Messages, colorize: bool) -> Option<String> {
    bot.can_join_groups
        .then(|| warn(&(messages.groups_warning)(&bot.username), colorize))
}

struct Stage<'a, 'b> {
    screen: &'a mut Screen<'b>,
    refused: bool,
}

impl Stage<'_, '_> {
    fn ready_to_wait(&self) -> Result<(), Failure> {
        if self.refused {
            Err(Failure::Screen)
        } else {
            Ok(())
        }
    }

    fn colorize(&self) -> bool {
        self.screen.colorize_out
    }

    fn show(&mut self, line: &str) {
        let out = &mut *self.screen.out;

        if out
            .write_all(format!("{line}\n").as_bytes())
            .and_then(|()| out.flush())
            .is_err()
        {
            self.refused = true;
        }
    }

    fn begin_wait(&mut self, text: &str) -> Result<Pending, Failure> {
        self.ready_to_wait()?;

        let waiting = pending(
            text,
            self.screen.out,
            self.screen.terminal,
            self.screen.colorize_out,
            self.screen.spin,
        );

        if waiting.refused() {
            self.refused = true;
            let _cleared = waiting.finish(None, self.screen.out);

            return Err(Failure::Screen);
        }

        Ok(waiting)
    }

    fn end_wait(&mut self, waiting: Pending, line: Option<&str>) {
        if waiting.finish(line, self.screen.out).is_err() {
            self.refused = true;
        }
    }

    fn showing<T>(
        &mut self,
        text: &str,
        work: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, Failure> {
        let waiting = self.begin_wait(text)?;
        let result = work();

        self.end_wait(waiting, None);

        result.map_err(Failure::Failed)
    }
}

pub fn load_saved_bot(
    setup: &TelegramSetup<'_>,
    screen: &mut Screen<'_>,
) -> Result<SavedBot, Failure> {
    let messages = setup.messages;
    let token = setup
        .saved_token()
        .ok_or_else(|| (messages.no_saved_token)(&format!("{SETUP_COMMAND} token")))?;
    let mut stage = Stage {
        screen,
        refused: false,
    };
    let bot = stage.showing(messages.saved_bot_checking, || {
        setup.call(&token, "getMe", &json!({}))
    })?;
    let mut saved = saved_bot(&token, bot.as_ref())?;

    saved.screen_refused = stage.refused;

    Ok(saved)
}

fn save_token(
    setup: &TelegramSetup<'_>,
    token: &str,
    bot: Option<&Value>,
    stage: &mut Stage<'_, '_>,
    tracks: &mut dyn Tracks,
) -> Result<SavedBot, Failure> {
    let env_file = join_path(setup.state_dir, ENV_FILE);
    let not_saved = |_| FileFailure::NotSaved(env_file.clone()).message(setup.messages);

    tracks.track_dir(setup.state_dir);
    create_private_dir(setup.state_dir).map_err(not_saved)?;
    tracks.track_file(&env_file).map_err(not_saved)?;
    write_private(
        &link_target(&env_file),
        format!("TELEGRAM_BOT_TOKEN={token}\n").as_bytes(),
    )
    .map_err(not_saved)?;

    let username = undefined_or(property(bot, "username")?);
    let saved = (setup.messages.token_saved)(&username, &env_file.to_string_lossy());
    let line = success(&saved, stage.colorize());

    stage.show(&line);

    let mut saved = saved_bot(token, bot)?;

    saved.screen_refused = stage.refused;

    Ok(saved)
}

pub fn ensure_token<P: Prompts>(
    setup: &TelegramSetup<'_>,
    offer_saved: bool,
    screen: &mut Screen<'_>,
    prompts: &mut P,
    tracks: &mut dyn Tracks,
) -> Result<SavedBot, P::Error> {
    let messages = setup.messages;
    let mut stage = Stage {
        screen,
        refused: false,
    };

    if let Some(saved) = setup.saved_token().filter(|_| offer_saved) {
        let bot = stage.showing(messages.saved_bot_checking, || {
            Ok(setup.call(&saved, "getMe", &json!({})).ok().flatten())
        })?;

        if let Some(bot) = bot.filter(js_truthy) {
            let username = undefined_or(field(Some(&bot), "username"));

            stage.ready_to_wait()?;

            if prompts.yes_no(&(messages.use_saved_bot)(&username))? {
                return saved_bot(&saved, Some(&bot))
                    .map_err(Failure::from)
                    .map_err(P::Error::from);
            }
        }
    }

    stage.ready_to_wait()?;

    let token = prompts.hidden(messages.token_prompt)?;
    let bot = stage.showing(messages.token_checking, || {
        setup.call(&token, "getMe", &json!({}))
    })?;

    save_token(setup, &token, bot.as_ref(), &mut stage, tracks).map_err(P::Error::from)
}

#[must_use]
pub fn paired_accounts(setup: &TelegramSetup<'_>, user_ids: &[Value], token: &str) -> String {
    user_ids
        .iter()
        .map(|user_id| {
            let chat = setup
                .call(token, "getChat", &json!({ "chat_id": user_id }))
                .ok()
                .flatten();
            let name = field(chat.as_ref(), "username")
                .filter(|username| js_truthy(username))
                .map_or_else(
                    || {
                        field(chat.as_ref(), "first_name")
                            .filter(|name| js_truthy(name))
                            .map(js_template)
                    },
                    |username| Some(format!("@{}", js_template(username))),
                );
            let id = js_template(user_id);

            name.map_or_else(|| format!("id {id}"), |name| format!("{name} (id {id})"))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn wait_for_pairing_message(
    setup: &TelegramSetup<'_>,
    token: &str,
    offset: f64,
    code: &str,
) -> Result<Candidate, String> {
    let deadline = (setup.now)().saturating_add(PAIRING_TIMEOUT_MS);
    let mut next = offset;

    while (setup.now)() < deadline {
        let updates = setup.call(
            token,
            "getUpdates",
            &json!({
                "offset": number(next),
                "timeout": LONG_POLL_SECONDS,
                "allowed_updates": ["message"],
            }),
        )?;

        if let Some(candidate) = find_pairing_candidate(updates.as_ref(), code)? {
            return Ok(candidate);
        }

        next = js_max(next, last_update_id(updates.as_ref())? + 1.0);
    }

    Err(setup.messages.no_pairing_message.to_owned())
}

fn request_pairing(
    setup: &TelegramSetup<'_>,
    bot: &SavedBot,
    stage: &mut Stage<'_, '_>,
) -> Result<Candidate, Failure> {
    let messages = setup.messages;

    if (setup.is_running)(setup.state_dir).is_some() {
        return Err(Failure::Failed(
            messages.close_instance_before_pairing.to_owned(),
        ));
    }

    let backlog = stage.showing(messages.pairing_preparing, || {
        let webhook = setup.call(&bot.token, "getWebhookInfo", &json!({}))?;

        if property(webhook.as_ref(), "url")?.is_some_and(js_truthy) {
            return Err((messages.webhook_configured)(&bot.username));
        }

        setup.call(
            &bot.token,
            "getUpdates",
            &json!({ "offset": -1, "timeout": 0 }),
        )
    })?;
    let code =
        pairing_code(setup.random).ok_or_else(|| Failure::Failed(NO_RANDOM_BYTES.to_owned()))?;
    let colorize = stage.colorize();

    stage.show(&(messages.send_pairing_code)(
        &bot.username,
        &bold(&code, colorize),
        &link(&pairing_link(&bot.username, &code), colorize),
    ));

    stage.showing(messages.pairing_waiting, || {
        let offset = last_update_id(backlog.as_ref())? + 1.0;

        wait_for_pairing_message(setup, &bot.token, offset, &code)
    })
}

fn finish_pairing(
    setup: &TelegramSetup<'_>,
    token: &str,
    current: Option<&Value>,
    candidate: &Candidate,
    stage: &mut Stage<'_, '_>,
    tracks: &mut dyn Tracks,
) -> Result<(), Failure> {
    let messages = setup.messages;
    let access_file = join_path(setup.state_dir, ACCESS_FILE);
    let access = build_access(current, &candidate.user_id);
    let not_saved = |_| FileFailure::NotSaved(access_file.clone()).message(messages);

    tracks.track_file(&access_file).map_err(not_saved)?;
    write_private(
        &link_target(&access_file),
        format!("{}\n", stringify_pretty(&access)).as_bytes(),
    )
    .map_err(not_saved)?;

    let waiting = stage.begin_wait(messages.pairing_finishing)?;
    let greeted = setup
        .call(
            token,
            "getUpdates",
            &json!({ "offset": plus_one(candidate.update_id.as_ref()), "timeout": 0 }),
        )
        .and_then(|_| {
            setup.call(
                token,
                "sendMessage",
                &json!({ "chat_id": candidate.user_id, "text": messages.paired_chat_message }),
            )
        });

    match greeted {
        Ok(_) => {
            let label = undefined_or(candidate.label.as_ref());
            let line = success(&(messages.paired_with)(&label), stage.colorize());

            stage.end_wait(waiting, Some(&line));

            Ok(())
        }
        Err(message) => {
            stage.end_wait(waiting, None);

            Err(Failure::Failed(message))
        }
    }
}

pub fn ensure_pairing<P: Prompts>(
    setup: &TelegramSetup<'_>,
    bot: &SavedBot,
    screen: &mut Screen<'_>,
    prompts: &mut P,
    tracks: &mut dyn Tracks,
) -> Result<(), P::Error> {
    let messages = setup.messages;
    let saved_access = read_json(&join_path(setup.state_dir, ACCESS_FILE));
    let mut stage = Stage {
        screen,
        refused: bot.screen_refused,
    };

    if is_paired(saved_access.as_ref()) {
        let user_ids = saved_access
            .as_ref()
            .and_then(|access| access.get("allowFrom"))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let accounts = stage.showing(messages.paired_account_checking, || {
            Ok(paired_accounts(setup, user_ids, &bot.token))
        })?;

        stage.ready_to_wait()?;

        if prompts.pairing_choice(&accounts)? == PairingChoice::Keep {
            let kept = skipped(&(messages.already_paired)(&accounts), stage.colorize());

            stage.show(&kept);

            return stage.ready_to_wait().map_err(P::Error::from);
        }
    }

    let current = saved_access
        .as_ref()
        .filter(|access| js_truthy(access))
        .map(|access| {
            let mut copy = spread(access);
            copy.insert("allowFrom".to_owned(), json!([]));
            Value::Object(copy)
        });
    let candidate = request_pairing(setup, bot, &mut stage)?;
    let label = undefined_or(candidate.label.as_ref());

    stage.ready_to_wait()?;

    if !prompts.yes_no(&(messages.confirm_pairing)(&label, &candidate.user_id))? {
        return Err(Failure::Failed(messages.pairing_cancelled.to_owned()).into());
    }

    finish_pairing(
        setup,
        &bot.token,
        current.as_ref(),
        &candidate,
        &mut stage,
        tracks,
    )?;

    stage.ready_to_wait().map_err(P::Error::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_follow_javascript_coercion() {
        assert!(to_number(None).is_nan());
        assert!(to_number(Some(&json!({}))).is_nan());
        assert!(to_number(Some(&json!([1, 2]))).is_nan());
        assert_eq!(to_number(Some(&json!(null))), 0.0);
        assert_eq!(to_number(Some(&json!(true))), 1.0);
        assert_eq!(to_number(Some(&json!(false))), 0.0);
        assert_eq!(to_number(Some(&json!([]))), 0.0);
        assert_eq!(to_number(Some(&json!(["7"]))), 7.0);
        assert_eq!(to_number(Some(&json!(" 8 "))), 8.0);
        assert!(js_max(1.0, f64::NAN).is_nan());
        assert!(js_max(f64::NAN, 1.0).is_nan());
        assert_eq!(js_max(1.0, 2.0), 2.0);
        assert_eq!(js_max(3.0, 2.0), 3.0);
    }

    #[test]
    fn adding_one_concatenates_text_and_adds_numbers() {
        assert_eq!(plus_one(Some(&json!("9"))), json!("91"));
        assert_eq!(plus_one(Some(&json!([1, 2]))), json!("1,21"));
        assert_eq!(plus_one(Some(&json!({}))), json!("[object Object]1"));
        assert_eq!(plus_one(Some(&json!(9))), json!(10.0));
        assert_eq!(plus_one(Some(&json!(null))), json!(1.0));
        assert_eq!(plus_one(Some(&json!(true))), json!(2.0));
        assert_eq!(plus_one(None), Value::Null);
    }

    #[test]
    fn spreading_text_splits_it_into_utf16_units() {
        let spread_text = spread(&json!("a😀"));

        assert_eq!(
            Value::Object(spread_text),
            json!({"0": "a", "1": "\u{fffd}", "2": "\u{fffd}"})
        );
        assert_eq!(spread(&json!(5)), Map::new());
    }

    #[test]
    fn the_debug_view_names_the_folder_and_the_api_root() {
        let setup = TelegramSetup {
            state_dir: Path::new("/state"),
            messages: crate::messages::messages_for(crate::locale::Locale::EnUs),
            fetch: &|_, _| None,
            api_root: "http://127.0.0.1:1",
            now: &|| 0,
            random: &random_bytes,
            is_running: &|_| None,
        };

        assert_eq!(
            format!("{setup:?}"),
            "TelegramSetup { state_dir: \"/state\", api_root: \"http://127.0.0.1:1\", .. }"
        );
    }

    #[test]
    fn the_confirmation_keeps_any_id_as_text() {
        let messages = crate::messages::messages_for(crate::locale::Locale::EnUs);

        assert_eq!(
            (messages.confirm_pairing)("Ana (id 0)", "1e+21"),
            "Pair with Ana (id 0) (id 1e+21)?"
        );
        assert_eq!(
            (messages.confirm_pairing)("@dev", "42"),
            "Pair with @dev (id 42)?"
        );
    }
}
