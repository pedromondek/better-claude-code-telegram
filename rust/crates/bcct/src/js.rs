use std::path::{Path, PathBuf};

use serde_json::Value;

const MAX_INTEGER_KEY: u32 = u32::MAX - 1;
const LAST_POSITIONAL_EXPONENT: i32 = 21;
const FIRST_POSITIONAL_EXPONENT: i32 = -5;
const ESCAPE_LENGTH: usize = 6;
const PRETTY_GAP: &str = "  ";
const REPLACEMENT_ESCAPE: &str = "\\ufffd";
const HIGH_SURROGATES: std::ops::RangeInclusive<u16> = 0xd800..=0xdbff;
const LOW_SURROGATES: std::ops::RangeInclusive<u16> = 0xdc00..=0xdfff;

#[must_use]
pub fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

#[must_use]
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

#[must_use]
pub fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64() != Some(0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

#[must_use]
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.as_f64().map_or_else(String::new, format_number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

#[must_use]
pub fn js_template(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        other => js_string(other),
    }
}

#[must_use]
pub fn js_length(value: &Value) -> Option<usize> {
    match value {
        Value::String(text) => Some(text.encode_utf16().count()),
        Value::Array(items) => Some(items.len()),
        _ => None,
    }
}

#[must_use]
pub fn js_key_count(value: Option<&Value>) -> usize {
    match value {
        Some(Value::Object(map)) => map.len(),
        Some(other) => js_length(other).unwrap_or_default(),
        None => 0,
    }
}

#[must_use]
pub fn js_basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');

    trimmed.rsplit('/').next().unwrap_or_default()
}

#[must_use]
pub fn js_number(text: &str) -> f64 {
    let trimmed = js_trim(text);

    if trimmed.is_empty() {
        return 0.0;
    }

    if let Some(value) = radix_number(trimmed) {
        return value;
    }

    let unsigned = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
    let negative = trimmed.starts_with('-');

    if unsigned == "Infinity" {
        return if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }

    if is_decimal_literal(unsigned) {
        trimmed.parse().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

fn radix_number(text: &str) -> Option<f64> {
    let (radix, digits) = [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ]
    .into_iter()
    .find_map(|(prefix, radix)| text.strip_prefix(prefix).map(|digits| (radix, digits)))?;

    if digits.is_empty() || !digits.chars().all(|digit| digit.is_digit(radix)) {
        return Some(f64::NAN);
    }

    Some(digits.chars().fold(0.0, |total, digit| {
        total * f64::from(radix) + f64::from(digit.to_digit(radix).unwrap_or(0))
    }))
}

fn is_decimal_literal(text: &str) -> bool {
    text.chars().all(|character| {
        character.is_ascii_digit() || matches!(character, '.' | 'e' | 'E' | '+' | '-')
    })
}

#[must_use]
pub fn parse_json(text: &str) -> Option<Value> {
    serde_json::from_str(&replace_lone_surrogates(text)).ok()
}

#[must_use]
pub fn replace_lone_surrogates(json: &str) -> String {
    let mut out = String::with_capacity(json.len());
    let mut rest = json;
    let mut low_is_paired = false;

    while let Some(start) = rest.find('\\') {
        let (before, escape) = rest.split_at(start);
        out.push_str(before);

        let Some((unit, code, after)) = split_escape(escape) else {
            let mut chars = escape.chars();
            out.extend(chars.by_ref().take(2));
            rest = chars.as_str();
            continue;
        };
        let lone = if HIGH_SURROGATES.contains(&unit) {
            !split_escape(after).is_some_and(|(low, _, _)| LOW_SURROGATES.contains(&low))
        } else {
            LOW_SURROGATES.contains(&unit) && !low_is_paired
        };

        out.push_str(if lone { REPLACEMENT_ESCAPE } else { code });
        low_is_paired = HIGH_SURROGATES.contains(&unit) && !lone;
        rest = after;
    }

    out.push_str(rest);
    out
}

fn split_escape(text: &str) -> Option<(u16, &str, &str)> {
    let (code, after) = text.split_at_checked(ESCAPE_LENGTH)?;
    let unit = u16::from_str_radix(code.strip_prefix("\\u")?, 16).ok()?;

    Some((unit, code, after))
}

#[must_use]
pub fn normalize_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    let absolute = text.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();

    for part in text.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|last| *last != "..") => {
                parts.pop();
            }
            ".." if absolute => {}
            other => parts.push(other),
        }
    }

    let body = parts.join("/");

    PathBuf::from(match (absolute, body.is_empty()) {
        (true, _) => format!("/{body}"),
        (false, true) => ".".to_owned(),
        (false, false) => body,
    })
}

#[must_use]
pub fn join_path(base: &Path, name: &str) -> PathBuf {
    if base.as_os_str().is_empty() {
        return normalize_path(Path::new(name));
    }

    normalize_path(Path::new(&format!("{}/{name}", base.to_string_lossy())))
}

#[must_use]
pub fn format_number(number: f64) -> String {
    if number == 0.0 {
        return "0".to_owned();
    }

    let sign = if number.is_sign_negative() { "-" } else { "" };
    let scientific = format!("{:e}", number.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let count = i32::try_from(digits.len()).unwrap_or(i32::MAX);
    let point = exponent.parse::<i32>().unwrap_or(0) + 1;

    let body = if (count..=LAST_POSITIONAL_EXPONENT).contains(&point) {
        format!("{digits}{}", "0".repeat(to_count(point - count)))
    } else if (1..=LAST_POSITIONAL_EXPONENT).contains(&point) {
        let (whole, fraction) = digits.split_at(to_count(point));
        format!("{whole}.{fraction}")
    } else if (FIRST_POSITIONAL_EXPONENT..=0).contains(&point) {
        format!("0.{}{digits}", "0".repeat(to_count(-point)))
    } else {
        scientific_notation(&digits, point - 1)
    };

    format!("{sign}{body}")
}

fn scientific_notation(digits: &str, exponent: i32) -> String {
    let (first, rest) = digits.split_at(1);
    let fraction = if rest.is_empty() {
        String::new()
    } else {
        format!(".{rest}")
    };
    let sign = if exponent.is_negative() { '-' } else { '+' };

    format!("{first}{fraction}e{sign}{}", exponent.abs())
}

fn to_count(value: i32) -> usize {
    usize::try_from(value).unwrap_or(0)
}

#[must_use]
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, &mut out, "", 0);
    out
}

#[must_use]
pub fn stringify_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, &mut out, PRETTY_GAP, 0);
    out
}

fn open_entry(out: &mut String, gap: &str, depth: usize, index: usize) {
    if index > 0 {
        out.push(',');
    }

    if !gap.is_empty() {
        out.push('\n');
        out.push_str(&gap.repeat(depth + 1));
    }
}

fn close_entries(out: &mut String, gap: &str, depth: usize, count: usize, close: char) {
    if count > 0 && !gap.is_empty() {
        out.push('\n');
        out.push_str(&gap.repeat(depth));
    }

    out.push(close);
}

fn write_value(value: &Value, out: &mut String, gap: &str, depth: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(&flag.to_string()),
        Value::Number(number) => {
            out.push_str(&format_number(number.as_f64().unwrap_or_default()));
        }
        Value::String(text) => out.push_str(&Value::String(text.clone()).to_string()),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                open_entry(out, gap, depth, index);
                write_value(item, out, gap, depth + 1);
            }
            close_entries(out, gap, depth, items.len(), ']');
        }
        Value::Object(map) => {
            out.push('{');
            for (index, (key, item)) in ordered_entries(map).into_iter().enumerate() {
                open_entry(out, gap, depth, index);
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                if !gap.is_empty() {
                    out.push(' ');
                }
                write_value(item, out, gap, depth + 1);
            }
            close_entries(out, gap, depth, map.len(), '}');
        }
    }
}

#[must_use]
pub fn ordered_entries(map: &serde_json::Map<String, Value>) -> Vec<(&String, &Value)> {
    let (mut indexed, named): (Vec<_>, Vec<_>) =
        map.iter().partition(|(key, _)| integer_key(key).is_some());

    indexed.sort_by_key(|(key, _)| integer_key(key));
    indexed.extend(named);
    indexed
}

fn integer_key(key: &str) -> Option<u32> {
    key.parse::<u32>()
        .ok()
        .filter(|index| *index <= MAX_INTEGER_KEY && index.to_string() == key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn trim_removes_exactly_the_javascript_whitespace_set() {
        assert_eq!(
            js_trim("\u{a0}\u{feff}\u{2028}\u{3000} a b \n\t\u{b}\u{c}\r"),
            "a b"
        );
        assert_eq!(js_trim("\u{85}x\u{200b}"), "\u{85}x\u{200b}");
        assert_eq!(js_trim("   "), "");
        assert!(is_js_whitespace('\u{2029}'));
        assert!(is_js_whitespace('\u{202f}'));
        assert!(is_js_whitespace('\u{205f}'));
        assert!(is_js_whitespace('\u{1680}'));
        assert!(is_js_whitespace('\u{200a}'));
        assert!(!is_js_whitespace('\u{200b}'));
        assert!(!is_js_whitespace('\u{180e}'));
    }

    #[test]
    fn truthiness_follows_javascript() {
        for falsy in [
            json!(null),
            json!(false),
            json!(0),
            json!(-0.0),
            json!(0.0),
            json!(""),
        ] {
            assert!(!js_truthy(&falsy), "{falsy}");
        }

        for truthy in [
            json!(true),
            json!(1),
            json!(-3),
            json!(0.5),
            json!("0"),
            json!("false"),
            json!(" "),
            json!([]),
            json!({}),
        ] {
            assert!(js_truthy(&truthy), "{truthy}");
        }
    }

    #[test]
    fn string_coercion_follows_javascript() {
        let cases = [
            (json!(null), ""),
            (json!(true), "true"),
            (json!(false), "false"),
            (json!(1.0), "1"),
            (json!(1e21), "1e+21"),
            (json!(0.1), "0.1"),
            (json!("text"), "text"),
            (json!([]), ""),
            (json!([1, [2, null], "a", true]), "1,2,,a,true"),
            (json!({"a": 1}), "[object Object]"),
            (json!([{}, [{}]]), "[object Object],[object Object]"),
        ];

        for (value, expected) in cases {
            assert_eq!(js_string(&value), expected, "{value}");
        }
    }

    #[test]
    fn numbers_print_like_javascript_number_to_string() {
        let cases: [(f64, &str); 28] = [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (100.0, "100"),
            (123.0, "123"),
            (1234.5678, "1234.5678"),
            (0.5, "0.5"),
            (0.1, "0.1"),
            (0.000_001, "0.000001"),
            (0.000_000_1, "1e-7"),
            (0.000_001_5, "0.0000015"),
            (0.000_000_15, "1.5e-7"),
            (1e20, "100000000000000000000"),
            (1.5e20, "150000000000000000000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (1.234_567_890_123_456_8e21, "1.2345678901234568e+21"),
            (5e-324, "5e-324"),
            (1.797_693_134_862_315_7e308, "1.7976931348623157e+308"),
            (4_294_967_296.0, "4294967296"),
            (1_700_000_000_123.0, "1700000000123"),
            (12.5, "12.5"),
            (-12.5, "-12.5"),
            (-1e21, "-1e+21"),
            (-1e-7, "-1e-7"),
            (9.0, "9"),
        ];

        for (number, expected) in cases {
            assert_eq!(format_number(number), expected, "{number}");
        }
    }

    #[test]
    fn stringify_matches_json_stringify() {
        let value: Value = serde_json::from_str(
            r#"{"b":1,"2":"two","a":[1.0,1E2,-0,0.10,1e21,null,true,"x\"\\\n\u0001\u007f é"],"1":{"z":[],"y":{}},"01":0,"4294967295":1,"4294967294":2,"-1":3,"+1":4}"#,
        )
        .unwrap();

        assert_eq!(
            stringify(&value),
            "{\"1\":{\"z\":[],\"y\":{}},\"2\":\"two\",\"4294967294\":2,\"b\":1,\"a\":[1,100,0,0.1,1e+21,null,true,\"x\\\"\\\\\\n\\u0001\u{7f}\u{2028}é\"],\"01\":0,\"4294967295\":1,\"-1\":3,\"+1\":4}"
        );
        assert_eq!(stringify(&json!({})), "{}");
        assert_eq!(stringify(&json!([])), "[]");
        assert_eq!(stringify(&json!(null)), "null");
        assert_eq!(stringify(&json!("a")), "\"a\"");
        assert_eq!(stringify(&json!(false)), "false");
        assert_eq!(stringify(&json!([1, 2])), "[1,2]");
        assert_eq!(stringify(&json!({"a": 1, "b": 2})), "{\"a\":1,\"b\":2}");
    }

    #[test]
    fn pretty_stringify_matches_json_stringify_with_two_spaces() {
        let value: Value = serde_json::from_str(
            r#"{"b":1,"2":"two","a":[1.0,[],{},[1,[2]],{"x":null}],"1":{"z":[],"y":{"k":"é"}},"s":"q\"\\"}"#,
        )
        .unwrap();

        assert_eq!(
            stringify_pretty(&value),
            "{\n  \"1\": {\n    \"z\": [],\n    \"y\": {\n      \"k\": \"é\"\n    }\n  },\n  \"2\": \"two\",\n  \"b\": 1,\n  \"a\": [\n    1,\n    [],\n    {},\n    [\n      1,\n      [\n        2\n      ]\n    ],\n    {\n      \"x\": null\n    }\n  ],\n  \"s\": \"q\\\"\\\\\"\n}"
        );
        assert_eq!(stringify_pretty(&json!([])), "[]");
        assert_eq!(stringify_pretty(&json!({})), "{}");
        assert_eq!(stringify_pretty(&json!([[]])), "[\n  []\n]");
        assert_eq!(stringify_pretty(&json!(5)), "5");
        assert_eq!(stringify_pretty(&json!({"a": 1})), "{\n  \"a\": 1\n}");
    }

    #[test]
    fn lone_surrogate_escapes_become_the_replacement_character() {
        let cases = [
            ("'%ud83d'", "'%ufffd'"),
            ("'%uDE00 x'", "'%ufffd x'"),
            ("'a%ud83d%u0041'", "'a%ufffd%u0041'"),
            ("'%ud83d%ud83d%ude00'", "'%ufffd%ud83d%ude00'"),
            ("'%ud83d%ude00'", "'%ud83d%ude00'"),
            ("'%u0041%ude00'", "'%u0041%ufffd'"),
            ("'%ud83d%ude00%ude00'", "'%ud83d%ude00%ufffd'"),
            ("'%uD83D%uDE00'", "'%uD83D%uDE00'"),
            ("'%%ud83d'", "'%%ud83d'"),
            ("'%%%ud83d'", "'%%%ufffd'"),
            ("'%ud83d", "'%ufffd"),
            ("'%ud8", "'%ud8"),
            ("'%uzzzz'", "'%uzzzz'"),
            ("'%n é 😀'", "'%n é 😀'"),
            ("'%é'", "'%é'"),
            ("%", "%"),
        ];
        let json = |text: &str| text.replace('%', "\\").replace('\'', "\"");

        for (source, expected) in cases {
            assert_eq!(
                replace_lone_surrogates(&json(source)),
                json(expected),
                "{source}"
            );
        }
    }

    #[test]
    fn integer_keys_are_canonical_array_indexes_only() {
        assert_eq!(integer_key("0"), Some(0));
        assert_eq!(integer_key("10"), Some(10));
        assert_eq!(integer_key("4294967294"), Some(4_294_967_294));

        for key in [
            "",
            "01",
            "-1",
            "+1",
            "1.5",
            "4294967295",
            "99999999999",
            "a",
            " 1",
        ] {
            assert_eq!(integer_key(key), None, "{key:?}");
        }
    }

    #[test]
    fn templates_lengths_keys_and_basenames_follow_javascript() {
        assert_eq!(js_template(&json!(null)), "null");
        assert_eq!(js_template(&json!([null, 1, "a"])), ",1,a");
        assert_eq!(js_template(&json!({"a": 1})), "[object Object]");
        assert_eq!(js_template(&json!(2.5)), "2.5");
        assert_eq!(js_length(&json!("😀a")), Some(3));
        assert_eq!(js_length(&json!([1, 2])), Some(2));
        assert_eq!(js_length(&json!({"length": 1})), None);
        assert_eq!(js_length(&json!(5)), None);
        assert_eq!(js_key_count(None), 0);
        assert_eq!(js_key_count(Some(&json!(null))), 0);
        assert_eq!(js_key_count(Some(&json!(7))), 0);
        assert_eq!(js_key_count(Some(&json!({"a": 1, "b": 2}))), 2);
        assert_eq!(js_key_count(Some(&json!([1, 2, 3]))), 3);
        assert_eq!(js_key_count(Some(&json!("ab"))), 2);

        for (path, expected) in [
            ("/bin/zsh", "zsh"),
            ("zsh", "zsh"),
            ("/bin/zsh//", "zsh"),
            ("/", ""),
            ("", ""),
            ("/bin/..", ".."),
        ] {
            assert_eq!(js_basename(path), expected, "{path}");
        }
    }

    #[test]
    fn paths_normalize_like_node_path_join() {
        let cases = [
            ("/a/b", "c", "/a/b/c"),
            ("/a/b/", "c", "/a/b/c"),
            ("/a//b", "./c", "/a/b/c"),
            ("/a/b", "../c", "/a/c"),
            ("/a/b", "../../../c", "/c"),
            ("/a/b", "x/../../c", "/a/c"),
            ("/", "c", "/c"),
            ("rel", "c", "rel/c"),
            ("rel", "../../c", "../c"),
            ("rel", "../c", "c"),
            ("../x", "..", ".."),
            ("a", "...", "a/..."),
            ("/a", "/abs", "/a/abs"),
            (".", "c", "c"),
            ("", ".bashrc", ".bashrc"),
            ("", "../c", "../c"),
            ("", "/c", "/c"),
        ];

        for (base, name, expected) in cases {
            assert_eq!(
                join_path(Path::new(base), name),
                PathBuf::from(expected),
                "{base} + {name}"
            );
        }

        assert_eq!(normalize_path(Path::new("/")), PathBuf::from("/"));
        assert_eq!(normalize_path(Path::new("")), PathBuf::from("."));
        assert_eq!(normalize_path(Path::new("a/..")), PathBuf::from("."));
        assert_eq!(normalize_path(Path::new("/..")), PathBuf::from("/"));
        assert_eq!(normalize_path(Path::new("../..")), PathBuf::from("../.."));
    }
}
