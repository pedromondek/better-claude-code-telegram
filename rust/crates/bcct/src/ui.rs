use std::ffi::OsString;

#[derive(Debug, Clone, Copy)]
struct Style {
    open: &'static str,
    close: &'static str,
    keep_close: bool,
}

const COLOR_CLOSE: &str = "\u{1b}[39m";
const INTENSITY_CLOSE: &str = "\u{1b}[22m";
const RED: Style = Style {
    open: "\u{1b}[31m",
    close: COLOR_CLOSE,
    keep_close: false,
};
const GREEN: Style = Style {
    open: "\u{1b}[32m",
    close: COLOR_CLOSE,
    keep_close: false,
};
const YELLOW: Style = Style {
    open: "\u{1b}[33m",
    close: COLOR_CLOSE,
    keep_close: false,
};
const BLUE: Style = Style {
    open: "\u{1b}[34m",
    close: COLOR_CLOSE,
    keep_close: false,
};
const CYAN: Style = Style {
    open: "\u{1b}[36m",
    close: COLOR_CLOSE,
    keep_close: false,
};
const MAGENTA: Style = Style {
    open: "\u{1b}[35m",
    close: COLOR_CLOSE,
    keep_close: false,
};
const BOLD: Style = Style {
    open: "\u{1b}[1m",
    close: INTENSITY_CLOSE,
    keep_close: true,
};
const DIM: Style = Style {
    open: "\u{1b}[2m",
    close: INTENSITY_CLOSE,
    keep_close: true,
};
const UNDERLINE: Style = Style {
    open: "\u{1b}[4m",
    close: "\u{1b}[24m",
    keep_close: false,
};
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

fn reopened(text: &str, style: Style) -> String {
    let mut out = String::new();
    let mut rest = text;

    while let Some(index) = rest.find(style.close) {
        let (before, from_close) = rest.split_at(index);
        let after = from_close.get(style.close.len()..).unwrap_or_default();

        if after.is_empty() {
            break;
        }

        out.push_str(before);

        if style.keep_close {
            out.push_str(style.close);
        }

        out.push_str(style.open);
        rest = after;
    }

    out.push_str(rest);
    out
}

fn paint(text: &str, styles: &[Style], colorize: bool) -> String {
    if !colorize {
        return text.to_owned();
    }

    let mut open = String::new();
    let mut close = String::new();
    let mut body = text.to_owned();

    for style in styles {
        open.push_str(style.open);
        close.insert_str(0, style.close);
        body = reopened(&body, *style);
    }

    format!("{open}{body}{close}")
}

#[must_use]
pub fn fail(text: &str, colorize: bool) -> String {
    paint(&format!("✘ {text}"), &[RED], colorize)
}

#[must_use]
pub fn success(text: &str, colorize: bool) -> String {
    paint(&format!("✔ {text}"), &[GREEN], colorize)
}

#[must_use]
pub fn skipped(text: &str, colorize: bool) -> String {
    paint(&format!("○ {text}"), &[DIM], colorize)
}

#[must_use]
pub fn section(text: &str, colorize: bool) -> String {
    paint(text, &[BLUE, BOLD], colorize)
}

#[must_use]
pub fn note(text: &str, colorize: bool) -> String {
    paint(text, &[DIM], colorize)
}

#[must_use]
pub fn frame(text: &str, colorize: bool) -> String {
    paint(text, &[CYAN], colorize)
}

#[must_use]
pub fn warn(text: &str, colorize: bool) -> String {
    paint(&format!("⚠ {text}"), &[YELLOW], colorize)
}

#[must_use]
pub fn info(text: &str, colorize: bool) -> String {
    paint(text, &[BLUE], colorize)
}

#[must_use]
pub fn link(text: &str, colorize: bool) -> String {
    paint(text, &[BLUE, UNDERLINE], colorize)
}

#[must_use]
pub fn bold(text: &str, colorize: bool) -> String {
    paint(text, &[BOLD], colorize)
}

#[must_use]
pub fn green(text: &str, colorize: bool) -> String {
    paint(text, &[GREEN], colorize)
}

#[must_use]
pub fn cyan_bold(text: &str, colorize: bool) -> String {
    paint(text, &[CYAN, BOLD], colorize)
}

#[must_use]
pub fn step_heading(index: usize, total: usize, title: &str, icon: &str, colorize: bool) -> String {
    let rule = paint("──", &[DIM], colorize);
    let number = paint(&index.to_string(), &[MAGENTA, BOLD], colorize);
    let of_total = paint(&format!("/{total}"), &[DIM], colorize);
    let shown_title = paint(title, &[MAGENTA, BOLD], colorize);

    format!("\n{rule} {icon} {number}{of_total} {shown_title} {rule}")
}

const DEFAULT_WORDS: [&str; 2] = ["[default", "[padrão"];
const YES_NO_SHAPE: usize = 6;

fn bracket_end(text: &str, start: usize) -> Option<usize> {
    let rest = text.get(start..)?;

    DEFAULT_WORDS
        .iter()
        .any(|word| rest.starts_with(word))
        .then(|| rest.find(']'))
        .flatten()
        .map(|close| start + close + 1)
}

fn yes_no_prefix(text: &str, start: usize) -> bool {
    text.get(start..)
        .map(str::as_bytes)
        .and_then(|rest| rest.get(..YES_NO_SHAPE))
        .is_some_and(|shape| {
            matches!(shape, [b'(', letter, b'/', b'n', b')', b' '] if letter.is_ascii_lowercase())
        })
}

fn default_hint_span(text: &str) -> Option<(usize, usize)> {
    text.char_indices()
        .map(|(start, _)| start)
        .find_map(|start| {
            let with_prefix = yes_no_prefix(text, start)
                .then(|| bracket_end(text, start + YES_NO_SHAPE))
                .flatten();

            with_prefix
                .or_else(|| bracket_end(text, start))
                .map(|end| (start, end))
        })
}

#[must_use]
pub fn question(prompt: &str, colorize: bool) -> String {
    let Some((start, end)) = default_hint_span(prompt) else {
        return bold(prompt, colorize);
    };
    let before = prompt.get(..start).unwrap_or_default();
    let hint = prompt.get(start..end).unwrap_or_default();
    let after = prompt.get(end..).unwrap_or_default();

    format!("{}{}{after}", bold(before, colorize), note(hint, colorize))
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

    const ANGLE: Style = Style {
        open: "<",
        close: ">",
        keep_close: false,
    };
    const KEPT: Style = Style {
        open: "(",
        close: ")",
        keep_close: true,
    };

    #[test]
    fn a_close_code_at_the_very_end_is_kept_and_the_others_reopen_the_color() {
        assert_eq!(paint("a", &[ANGLE], true), "<a>");
        assert_eq!(paint("a>b", &[ANGLE], true), "<a<b>");
        assert_eq!(paint("a>", &[ANGLE], true), "<a>>");
        assert_eq!(paint(">>", &[ANGLE], true), "<<>>");
        assert_eq!(paint("", &[ANGLE], true), "<>");
        assert_eq!(paint("a>b", &[ANGLE], false), "a>b");
    }

    #[test]
    fn a_shared_close_code_closes_and_reopens_like_node() {
        assert_eq!(paint("a)b", &[KEPT], true), "(a)(b)");
        assert_eq!(paint("))", &[KEPT], true), "()())");
        assert_eq!(paint("a)", &[KEPT], true), "(a))");
        assert_eq!(paint("x)y>z", &[ANGLE, KEPT], true), "<(x)(y<z)>");
        assert_eq!(paint("x>", &[ANGLE, KEPT], true), "<(x>)>");
    }

    #[test]
    fn the_warning_and_the_option_colors_have_their_node_style() {
        assert_eq!(warn("x", true), "\u{1b}[33m⚠ x\u{1b}[39m");
        assert_eq!(info("x", true), "\u{1b}[34mx\u{1b}[39m");
        assert_eq!(green("x", true), "\u{1b}[32mx\u{1b}[39m");
        assert_eq!(warn("x", false), "⚠ x");
        assert_eq!(info("x", false), "x");
        assert_eq!(green("x", false), "x");
    }

    #[test]
    fn each_mark_has_its_node_style() {
        assert_eq!(success("x", true), "\u{1b}[32m✔ x\u{1b}[39m");
        assert_eq!(skipped("x", true), "\u{1b}[2m○ x\u{1b}[22m");
        assert_eq!(
            section("Install", true),
            "\u{1b}[34m\u{1b}[1mInstall\u{1b}[22m\u{1b}[39m"
        );
        assert_eq!(
            section("a\u{1b}[22mb", true),
            "\u{1b}[34m\u{1b}[1ma\u{1b}[22m\u{1b}[1mb\u{1b}[22m\u{1b}[39m"
        );
        assert_eq!(note("x", true), "\u{1b}[2mx\u{1b}[22m");
        assert_eq!(frame("⠋", true), "\u{1b}[36m⠋\u{1b}[39m");
        assert_eq!(success("x", false), "✔ x");
        assert_eq!(skipped("x", false), "○ x");
        assert_eq!(section("x", false), "x");
        assert_eq!(note("x", false), "x");
        assert_eq!(frame("x", false), "x");
    }
}
