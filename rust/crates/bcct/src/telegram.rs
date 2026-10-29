use std::ffi::OsString;
use std::fmt::Write as _;
use std::time::Duration;

use serde_json::Value;

use crate::js::{js_template, js_truthy, parse_json, stringify};
use crate::messages::Messages;

pub const API_ROOT_ENV: &str = "BETTER_CC_TELEGRAM_API_ROOT";
pub const DEFAULT_API_ROOT: &str = "https://api.telegram.org";

const SCHEME_END: &str = "://";
const AUTHORITY_END: [char; 4] = ['/', '\\', '?', '#'];
const PATH_ENCODED: &str = "\"#<>?^`{}";
const QUERY_ENCODED: &str = "\"#<>'";
const BYTE_ORDER_MARK: char = '\u{feff}';
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_REDIRECTS: u32 = 20;

pub type Fetch<'a> = &'a dyn Fn(&str, &str) -> Option<Vec<u8>>;

#[must_use]
pub fn api_root(var: &dyn Fn(&str) -> Option<OsString>) -> String {
    let root = var(API_ROOT_ENV)
        .map(|root| root.to_string_lossy().into_owned())
        .unwrap_or_default();

    if root.is_empty() {
        DEFAULT_API_ROOT.to_owned()
    } else {
        root
    }
}

fn encoded(character: char, extra: &str) -> String {
    if character > ' ' && character < '\u{7f}' && !extra.contains(character) {
        return character.to_string();
    }

    let mut bytes = [0; 4];

    character
        .encode_utf8(&mut bytes)
        .bytes()
        .fold(String::new(), |mut out, byte| {
            let _formatted = write!(out, "%{byte:02X}");
            out
        })
}

fn is_single_dot(segment: &str) -> bool {
    segment == "." || segment.eq_ignore_ascii_case("%2e")
}

fn is_double_dot(segment: &str) -> bool {
    matches!(
        segment.to_ascii_lowercase().as_str(),
        ".." | ".%2e" | "%2e." | "%2e%2e"
    )
}

fn path_and_query(rest: &str) -> String {
    let before_fragment = rest.split('#').next().unwrap_or_default();
    let (path, query) = before_fragment
        .split_once('?')
        .map_or((before_fragment, None), |(path, query)| (path, Some(query)));
    let inside = path
        .strip_prefix(['/', '\\'])
        .unwrap_or(path)
        .replace('\\', "/");
    let mut segments: Vec<String> = Vec::new();
    let parts: Vec<&str> = inside.split('/').collect();
    let last = parts.len() - 1;

    for (index, part) in parts.into_iter().enumerate() {
        let segment: String = part
            .chars()
            .map(|character| encoded(character, PATH_ENCODED))
            .collect();

        if is_double_dot(&segment) {
            segments.pop();

            if index == last {
                segments.push(String::new());
            }
        } else if !is_single_dot(&segment) {
            segments.push(segment);
        } else if index == last {
            segments.push(String::new());
        }
    }

    let query: String = query
        .unwrap_or_default()
        .chars()
        .map(|character| encoded(character, QUERY_ENCODED))
        .collect();
    let search = if query.is_empty() {
        String::new()
    } else {
        format!("?{query}")
    };

    format!("/{}{search}", segments.join("/"))
}

#[must_use]
pub fn request_url(api_root: &str, token: &str, method: &str) -> String {
    let joined: String = format!("{api_root}/bot{token}/{method}")
        .chars()
        .filter(|character| !matches!(character, '\t' | '\n' | '\r'))
        .collect();
    let url = joined.trim_matches(|character: char| character <= ' ');

    let Some(scheme_end) = url.find(SCHEME_END) else {
        return url.to_owned();
    };
    let (scheme, after_scheme) = url.split_at(scheme_end);
    let after_scheme = after_scheme.get(SCHEME_END.len()..).unwrap_or_default();
    let authority_end = after_scheme
        .find(AUTHORITY_END)
        .unwrap_or(after_scheme.len());
    let (authority, rest) = after_scheme.split_at(authority_end);

    format!("{scheme}{SCHEME_END}{authority}{}", path_and_query(rest))
}

fn missing_property(of: &str, key: &str) -> String {
    format!("Cannot read properties of {of} (reading '{key}')")
}

pub fn property<'a>(value: Option<&'a Value>, key: &str) -> Result<Option<&'a Value>, String> {
    match value {
        None => Err(missing_property("undefined", key)),
        Some(Value::Null) => Err(missing_property("null", key)),
        Some(Value::Object(map)) => Ok(map.get(key)),
        Some(_) => Ok(None),
    }
}

pub fn call(
    fetch: Fetch<'_>,
    api_root: &str,
    token: &str,
    method: &str,
    params: &Value,
    messages: &Messages,
) -> Result<Option<Value>, String> {
    let body = fetch(&request_url(api_root, token, method), &stringify(params))
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .and_then(|text| parse_json(text.strip_prefix(BYTE_ORDER_MARK).unwrap_or(&text)))
        .ok_or_else(|| (messages.network_failure)(method))?;

    if property(Some(&body), "ok")?.is_some_and(js_truthy) {
        return Ok(body.get("result").cloned());
    }

    let description = body
        .get("description")
        .filter(|description| !description.is_null())
        .map_or_else(|| messages.no_description.to_owned(), js_template);

    Err((messages.telegram_refused)(method, &description))
}

#[must_use]
pub fn post_json(url: &str, body: &str) -> Option<Vec<u8>> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .proxy(None)
        .http_status_as_error(false)
        .max_redirects(MAX_REDIRECTS)
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_recv_response(Some(RESPONSE_TIMEOUT))
        .timeout_recv_body(Some(RESPONSE_TIMEOUT))
        .build()
        .into();
    let mut response = agent
        .post(url)
        .header("content-type", "application/json")
        .send(body)
        .ok()?;

    response
        .body_mut()
        .with_config()
        .limit(u64::MAX)
        .read_to_vec()
        .ok()
}
