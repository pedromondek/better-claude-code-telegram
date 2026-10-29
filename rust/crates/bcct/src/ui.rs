use std::ffi::OsString;

const RED_OPEN: &str = "\u{1b}[31m";
const RED_CLOSE: &str = "\u{1b}[39m";
const FORCE_COLOR: &str = "FORCE_COLOR";
const FORCED_COLORS: [&str; 5] = ["", "1", "true", "2", "3"];
const CI_SERVICES: [&str; 8] = [
    "APPVEYOR",
    "BUILDKITE",
    "CIRCLECI",
    "DRONE",
    "GITEA_ACTIONS",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "TRAVIS",
];
const COLOR_TERMINAL_PROGRAMS: [&str; 4] = ["iTerm.app", "HyperTerm", "MacTerm", "Apple_Terminal"];
const COLOR_TERMS: [&str; 17] = [
    "eterm",
    "cons25",
    "console",
    "cygwin",
    "dtterm",
    "gnome",
    "hurd",
    "jfbterm",
    "konsole",
    "kterm",
    "mlterm",
    "mosh",
    "putty",
    "st",
    "rxvt-unicode-24bit",
    "terminator",
    "xterm-kitty",
];
const LOWERCASE_OBJECT_KEYS: [&str; 2] = ["constructor", "__proto__"];
const TRUE_COLORTERMS: [&str; 2] = ["truecolor", "24bit"];
const TERM_PARTS: [&str; 4] = ["ansi", "color", "linux", "direct"];
const TERM_PREFIXES: [&str; 5] = ["rxvt", "screen", "xterm", "vt100", "vt220"];

fn text_of(var: &dyn Fn(&str) -> Option<OsString>, name: &str) -> Option<String> {
    var(name).map(|value| value.to_string_lossy().into_owned())
}

fn filled(var: &dyn Fn(&str) -> Option<OsString>, name: &str) -> bool {
    var(name).is_some_and(|value| !value.is_empty())
}

fn teamcity_colors(version: &str) -> bool {
    let digits = version.bytes().take_while(u8::is_ascii_digit).count();
    let rest = version.get(digits..).unwrap_or_default();

    if digits >= 2 {
        return rest.starts_with('.');
    }

    let Some(minor) = version.strip_prefix("9.") else {
        return false;
    };
    let minor_digits = minor.bytes().take_while(u8::is_ascii_digit).count();

    minor.bytes().take(minor_digits).any(|digit| digit != b'0')
        && minor
            .get(minor_digits..)
            .is_some_and(|after| after.starts_with('.'))
}

fn console_size_term(term: &str) -> bool {
    term.strip_prefix("con").is_some_and(|rest| {
        let rest = rest.trim_start_matches(|character: char| character.is_ascii_digit());

        rest.strip_prefix('x')
            .is_some_and(|after| after.starts_with(|character: char| character.is_ascii_digit()))
    })
}

fn term_colors(term: &str) -> Option<bool> {
    let lower = term.to_lowercase();

    if LOWERCASE_OBJECT_KEYS.contains(&lower.as_str()) {
        return Some(false);
    }

    (COLOR_TERMS.contains(&lower.as_str())
        || TERM_PARTS.iter().any(|part| lower.contains(part))
        || TERM_PREFIXES.iter().any(|prefix| lower.starts_with(prefix))
        || console_size_term(&lower))
    .then_some(true)
}

#[must_use]
pub fn colors_available(var: &dyn Fn(&str) -> Option<OsString>) -> bool {
    if let Some(force) = text_of(var, FORCE_COLOR) {
        return FORCED_COLORS.contains(&force.as_str());
    }

    if filled(var, "NODE_DISABLE_COLORS")
        || filled(var, "NO_COLOR")
        || text_of(var, "TERM").is_some_and(|term| term == "dumb")
    {
        return false;
    }

    if filled(var, "TMUX") || (var("TF_BUILD").is_some() && var("AGENT_NAME").is_some()) {
        return true;
    }

    if var("CI").is_some() {
        return CI_SERVICES.iter().any(|service| var(service).is_some())
            || text_of(var, "CI_NAME").is_some_and(|name| name == "codeship");
    }

    if let Some(version) = text_of(var, "TEAMCITY_VERSION") {
        return teamcity_colors(&version);
    }

    if text_of(var, "TERM_PROGRAM")
        .is_some_and(|program| COLOR_TERMINAL_PROGRAMS.contains(&program.as_str()))
    {
        return true;
    }

    if text_of(var, "COLORTERM")
        .is_some_and(|colorterm| TRUE_COLORTERMS.contains(&colorterm.as_str()))
    {
        return true;
    }

    if let Some(colors) = text_of(var, "TERM")
        .filter(|term| !term.is_empty())
        .and_then(|term| term_colors(&term))
    {
        return colors;
    }

    filled(var, "COLORTERM")
}

#[must_use]
pub fn should_colorize(var: &dyn Fn(&str) -> Option<OsString>, is_tty: bool) -> bool {
    (is_tty || var(FORCE_COLOR).is_some()) && colors_available(var)
}

fn paint(text: &str, open: &str, close: &str) -> String {
    let mut out = String::from(open);
    let mut rest = text;

    while let Some(index) = rest.find(close) {
        let (before, from_close) = rest.split_at(index);
        let after = from_close.get(close.len()..).unwrap_or_default();

        if after.is_empty() {
            break;
        }

        out.push_str(before);
        out.push_str(open);
        rest = after;
    }

    out.push_str(rest);
    out.push_str(close);
    out
}

#[must_use]
pub fn fail(text: &str, colorize: bool) -> String {
    let line = format!("✘ {text}");

    if colorize {
        paint(&line, RED_OPEN, RED_CLOSE)
    } else {
        line
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn colors(pairs: &[(&str, &str)]) -> bool {
        let variables: HashMap<String, OsString> = pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), OsString::from(value)))
            .collect();

        colors_available(&|name| variables.get(name).cloned())
    }

    #[test]
    fn teamcity_from_9_1_or_with_two_digits_paints() {
        for (version, expected) in [
            ("9.1.0", true),
            ("9.10.2", true),
            ("9.01.0", true),
            ("9.0.1", false),
            ("9.00.1", false),
            ("9.1", false),
            ("9.", false),
            ("10.0", true),
            ("10", false),
            ("2023.1", true),
            ("8.1.0", false),
            ("1.0", false),
            ("", false),
            ("x10.", false),
            ("9.x.", false),
        ] {
            assert_eq!(teamcity_colors(version), expected, "{version:?}");
        }
    }

    #[test]
    fn console_sizes_need_digits_after_the_x() {
        for (term, expected) in [
            ("con80x25", true),
            ("conx1", true),
            ("con1x", false),
            ("con80", false),
            ("cox1", false),
            ("con12a3x4", false),
        ] {
            assert_eq!(console_size_term(term), expected, "{term:?}");
        }
    }

    #[test]
    fn an_empty_term_falls_through_to_colorterm() {
        assert!(colors(&[("TERM", ""), ("COLORTERM", "1")]));
        assert!(!colors(&[("TERM", "")]));
        assert!(!colors(&[("TERM", "unknown")]));
        assert!(colors(&[("TERM", "unknown"), ("COLORTERM", "1")]));
        assert!(!colors(&[("TERM", "constructor"), ("COLORTERM", "1")]));
        assert!(!colors(&[("TERM", "__PROTO__"), ("COLORTERM", "1")]));
        assert!(colors(&[("TERM", "toString"), ("COLORTERM", "1")]));
        assert!(colors(&[("TERM", "constructor"), ("COLORTERM", "24bit")]));
        assert!(colors(&[
            ("TERM", "constructor"),
            ("COLORTERM", "truecolor")
        ]));
    }

    #[test]
    fn a_close_code_at_the_very_end_is_kept_and_the_others_reopen_the_color() {
        assert_eq!(paint("a", "<", ">"), "<a>");
        assert_eq!(paint("a>b", "<", ">"), "<a<b>");
        assert_eq!(paint("a>", "<", ">"), "<a>>");
        assert_eq!(paint(">>", "<", ">"), "<<>>");
        assert_eq!(paint("", "<", ">"), "<>");
    }
}
