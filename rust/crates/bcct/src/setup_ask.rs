use crate::config::DEFAULT_DELAY_MINUTES;
use crate::install::{
    CommandsChoice, DISABLE_ANSWERS, Parsed, TRANSCRIPTION_MODELS, TranscriptionChoice,
};
use crate::js::{format_number, is_js_whitespace, js_number, js_trim};
use crate::locale::Locale;
use crate::messages::Messages;
use crate::prompt::{
    Answer, ChoiceItem, ChoiceQuestion, Other, Prompter, ask_choice, ask_validated, index_of_value,
    marked, number_choices,
};
use crate::setup_files::StatuslineChoice;
use crate::setup_telegram::PairingChoice;

pub type QuietRange = (String, String);

const DELAY_PRESETS: [f64; 6] = [1.0, 3.0, 4.0, 5.0, 10.0, 15.0];
const INBOX_PRESETS: [f64; 5] = [1.0, 3.0, 7.0, 14.0, 30.0];
const QUIET_RANGES: [(&str, &str); 4] = [
    ("18:00", "08:00"),
    ("18:00", "07:00"),
    ("22:00", "07:00"),
    ("00:00", "07:00"),
];
const EN_US_LABEL: &str = "English / Inglês (en-us)";
const PT_BR_LABEL: &str = "Português Brasileiro / Brazilian Portuguese (pt-br)";
const EN_US_FLAG: &str = "🇺🇸";
const PT_BR_FLAG: &str = "🇧🇷";
const OTHER_ANSWER: &str = "N";
const OTHER_RANGE_ANSWER: &str = "HH:MM-HH:MM";
const OFF_ANSWER: &str = "off";
const KEEP_ANSWER: &str = "keep";
const NOT_ALIASES: [&str; 4] = ["n", "no", "não", "nao"];
const YES_ALIASES: [&str; 4] = ["s", "y", "sim", "yes"];
const LONG_DAYS: u64 = u64::MAX;
const STATUSLINE_KEEP_INDEX: usize = 3;

#[must_use]
pub fn parse_locale(answer: &str) -> Option<Locale> {
    Locale::parse(&js_trim(answer).to_lowercase().replace('_', "-"))
}

#[must_use]
pub fn parse_delay_minutes(answer: &str) -> Option<f64> {
    let trimmed = js_trim(answer);
    let minutes = js_number(&trimmed.replacen(',', ".", 1));

    (!trimmed.is_empty() && minutes.is_finite() && minutes > 0.0).then_some(minutes)
}

fn is_clock(text: &str) -> bool {
    match *text.as_bytes() {
        [first, second, b':', third, fourth] => {
            (matches!(first, b'0' | b'1') && second.is_ascii_digit()
                || first == b'2' && matches!(second, b'0'..=b'3'))
                && matches!(third, b'0'..=b'5')
                && fourth.is_ascii_digit()
        }
        _ => false,
    }
}

#[must_use]
pub fn parse_quiet_hours(answer: &str) -> Parsed<QuietRange> {
    let trimmed = js_trim(answer).to_lowercase();

    if trimmed.is_empty() {
        return Parsed::Keep;
    }

    if DISABLE_ANSWERS.contains(&trimmed.as_str()) {
        return Parsed::Off;
    }

    let Some((start, end)) = trimmed.split_once('-') else {
        return Parsed::Keep;
    };
    let start = start.trim_end_matches(is_js_whitespace);
    let end = end.trim_start_matches(is_js_whitespace);

    if is_clock(start) && is_clock(end) && start != end {
        Parsed::Value((start.to_owned(), end.to_owned()))
    } else {
        Parsed::Keep
    }
}

#[must_use]
pub fn quiet_answer(text: &str) -> Option<Option<QuietRange>> {
    match parse_quiet_hours(text) {
        Parsed::Value(range) => Some(Some(range)),
        Parsed::Off => Some(None),
        Parsed::Keep => None,
    }
}

#[must_use]
pub fn parse_time(text: &str) -> Option<String> {
    let trimmed = js_trim(text);
    let (hour, minute) = trimmed.split_once(':')?;
    let hour = match *hour.as_bytes() {
        [_] => format!("0{hour}"),
        _ => hour.to_owned(),
    };
    let time = format!("{hour}:{minute}");

    is_clock(&time).then_some(time)
}

fn is_whole_number(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

#[must_use]
pub fn parse_positive_days(text: &str) -> Option<f64> {
    let days = js_number(text);

    (is_whole_number(text) && days > 0.0).then_some(days)
}

#[must_use]
pub fn language_label(locale: Locale, flags: bool) -> String {
    let (flag, label) = match locale {
        Locale::EnUs => (EN_US_FLAG, EN_US_LABEL),
        Locale::PtBr => (PT_BR_FLAG, PT_BR_LABEL),
    };

    if flags {
        format!("{flag} {label}")
    } else {
        label.to_owned()
    }
}

pub fn ask_language(
    current: Locale,
    saved: bool,
    flags: bool,
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<Locale> {
    let options: Vec<ChoiceItem<Locale>> = Locale::ALL
        .into_iter()
        .map(|locale| {
            let name = locale.as_str();

            ChoiceItem::pick(&language_label(locale, flags), name, locale)
                .with_aliases(&[&name.replace('-', "_")])
        })
        .collect();
    let index = index_of_value(&options, &current);

    ask_choice(
        ChoiceQuestion {
            title: messages.language_question.to_owned(),
            choices: marked(options, index, saved, &|_| Vec::new(), messages),
            index,
            other: None,
            default_hint: Some(messages.language_default_hint),
        },
        messages,
        ask,
    )
}

pub fn ask_delay(
    current: f64,
    saved: bool,
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<f64> {
    let options = number_choices(&DELAY_PRESETS, Some(current), &|minutes| {
        (messages.delay_label)(minutes)
    });
    let index = index_of_value(&options, &current);
    let recommended = |choice: &ChoiceItem<f64>| {
        if choice.value() == Some(&DEFAULT_DELAY_MINUTES) {
            vec![messages.recommended.to_owned()]
        } else {
            Vec::new()
        }
    };
    let mut typed = |terminal: &mut dyn Prompter| {
        ask_validated(
            messages.delay_custom_prompt,
            &parse_delay_minutes,
            messages.delay_custom_hint,
            messages,
            terminal,
        )
    };

    ask_choice(
        ChoiceQuestion {
            title: messages.delay_question.to_owned(),
            choices: marked(options, index, saved, &recommended, messages),
            index,
            other: Some(Other {
                label: messages.custom.to_owned(),
                answer: OTHER_ANSWER.to_owned(),
                parse: &parse_delay_minutes,
                ask_on_terminal: &mut typed,
            }),
            default_hint: None,
        },
        messages,
        ask,
    )
}

fn inbox_label(messages: &Messages, days: f64) -> String {
    (messages.inbox_days_label)(LONG_DAYS).replacen(&LONG_DAYS.to_string(), &format_number(days), 1)
}

pub fn ask_inbox(
    current: Option<f64>,
    saved: bool,
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<Option<f64>> {
    let aliases: Vec<&str> = DISABLE_ANSWERS
        .into_iter()
        .filter(|answer| *answer != "0")
        .collect();
    let options: Vec<ChoiceItem<Option<f64>>> =
        number_choices(&INBOX_PRESETS, current, &|days| inbox_label(messages, days))
            .into_iter()
            .map(|choice| choice.map_value(Some))
            .chain([
                ChoiceItem::pick(messages.inbox_forever_label, OFF_ANSWER, None)
                    .with_aliases(&aliases),
            ])
            .collect();
    let index = index_of_value(&options, &current);
    let parse = |text: &str| parse_positive_days(text).map(Some);
    let mut typed = |terminal: &mut dyn Prompter| {
        ask_validated(
            messages.inbox_custom_prompt,
            &parse_positive_days,
            messages.inbox_custom_hint,
            messages,
            terminal,
        )
        .map(Some)
    };

    ask_choice(
        ChoiceQuestion {
            title: messages.inbox_question.to_owned(),
            choices: marked(options, index, saved, &|_| Vec::new(), messages),
            index,
            other: Some(Other {
                label: messages.custom.to_owned(),
                answer: OTHER_ANSWER.to_owned(),
                parse: &parse,
                ask_on_terminal: &mut typed,
            }),
            default_hint: None,
        },
        messages,
        ask,
    )
}

fn ask_quiet_range(
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<Option<QuietRange>> {
    let start = ask_validated(
        messages.quiet_start_prompt,
        &parse_time,
        messages.time_hint,
        messages,
        ask,
    )?;
    let end = ask_validated(
        messages.quiet_end_prompt,
        &|text| parse_time(text).filter(|time| *time != start),
        &(messages.quiet_end_hint)(&start),
        messages,
        ask,
    )?;

    Ok(Some((start, end)))
}

fn range_text((start, end): &QuietRange) -> String {
    format!("{start}-{end}")
}

pub fn ask_quiet_hours(
    current: Option<&QuietRange>,
    saved: bool,
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<Option<QuietRange>> {
    let names = messages.quiet_presets;
    let labels = [
        names.outside_work,
        names.full_night,
        names.night,
        names.late_night,
    ];
    let range = current.map(range_text);
    let presets: Vec<ChoiceItem<Option<QuietRange>>> = labels
        .into_iter()
        .zip(QUIET_RANGES)
        .map(|(label, (start, end))| {
            let answer = format!("{start}-{end}");

            ChoiceItem::pick(label, &answer, Some((start.to_owned(), end.to_owned())))
                .with_hint(&answer)
        })
        .collect();
    let own = current.filter(|_| {
        !QUIET_RANGES
            .iter()
            .any(|(start, end)| Some(format!("{start}-{end}")) == range)
    });
    let mut options: Vec<ChoiceItem<Option<QuietRange>>> = vec![
        ChoiceItem::pick(messages.quiet_off_label, OFF_ANSWER, None).with_aliases(&DISABLE_ANSWERS),
    ];

    options.extend(own.map(|own| {
        let text = range_text(own);

        ChoiceItem::pick(&text, &text, Some(own.clone()))
    }));
    options.extend(presets);

    let index = index_of_value(&options, &current.cloned());
    let mut typed = |terminal: &mut dyn Prompter| ask_quiet_range(messages, terminal);

    ask_choice(
        ChoiceQuestion {
            title: messages.quiet_question.to_owned(),
            choices: marked(options, index, saved, &|_| Vec::new(), messages),
            index,
            other: Some(Other {
                label: messages.custom.to_owned(),
                answer: OTHER_RANGE_ANSWER.to_owned(),
                parse: &quiet_answer,
                ask_on_terminal: &mut typed,
            }),
            default_hint: None,
        },
        messages,
        ask,
    )
}

fn model_option(model: &'static str, messages: &Messages) -> ChoiceItem<TranscriptionChoice> {
    let models = messages.transcription_models;
    let hint = match model {
        "base" => models.base,
        "small" => models.small,
        _ => models.medium,
    };

    ChoiceItem::pick(model, model, TranscriptionChoice::Model(model)).with_hint(hint)
}

pub fn ask_transcription(
    current: Option<&'static str>,
    saved: bool,
    installed: &[&'static str],
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<TranscriptionChoice> {
    let (downloaded, to_download): (Vec<&'static str>, Vec<&'static str>) = TRANSCRIPTION_MODELS
        .into_iter()
        .partition(|model| installed.contains(model));
    let mut options = vec![
        ChoiceItem::pick(
            messages.transcription_off_label,
            OFF_ANSWER,
            TranscriptionChoice::Off,
        )
        .with_aliases(&DISABLE_ANSWERS),
    ];

    if !downloaded.is_empty() {
        options.push(ChoiceItem::pick(
            messages.transcription_uninstall,
            "uninstall",
            TranscriptionChoice::Uninstall,
        ));
        options.push(ChoiceItem::heading(
            messages.transcription_installed_heading,
        ));
        options.extend(downloaded.iter().map(|model| model_option(model, messages)));

        if !to_download.is_empty() {
            options.push(ChoiceItem::heading(
                messages.transcription_available_heading,
            ));
        }
    }

    options.extend(
        to_download
            .iter()
            .map(|model| model_option(model, messages)),
    );

    let chosen = current.map_or(TranscriptionChoice::Off, TranscriptionChoice::Model);
    let index = index_of_value(&options, &chosen);

    ask_choice(
        ChoiceQuestion {
            title: messages.transcription_question.to_owned(),
            choices: marked(options, index, saved, &|_| Vec::new(), messages),
            index,
            other: None,
            default_hint: None,
        },
        messages,
        ask,
    )
}

#[must_use]
pub fn statusline_example(messages: &Messages) -> String {
    (messages.status_connected)(messages.status_main)
}

pub fn ask_statusline_choice(
    preview: &str,
    customized: bool,
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<StatuslineChoice> {
    let names = messages.statusline_choices;
    let hints = messages.statusline_choice_hints;
    let keep = if customized {
        names.keep_custom
    } else {
        names.keep
    };
    let choices = [
        (
            names.after,
            hints.after,
            "after",
            "1",
            StatuslineChoice::After,
        ),
        (
            names.replace,
            hints.replace,
            "replace",
            "2",
            StatuslineChoice::Replace,
        ),
        (
            names.custom,
            hints.custom,
            "custom",
            "3",
            StatuslineChoice::Custom,
        ),
        (keep, hints.keep, KEEP_ANSWER, "4", StatuslineChoice::Keep),
    ]
    .into_iter()
    .map(|(label, hint, answer, alias, value)| {
        ChoiceItem::pick(label, answer, value)
            .with_hint(hint)
            .with_aliases(&[alias])
    })
    .collect();

    ask_choice(
        ChoiceQuestion {
            title: (messages.statusline_choice_question)(preview, &statusline_example(messages)),
            choices,
            index: STATUSLINE_KEEP_INDEX,
            other: None,
            default_hint: None,
        },
        messages,
        ask,
    )
}

fn keep_or_remove(
    title: String,
    keep: (&str, &str),
    remove: (&str, &str),
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<CommandsChoice> {
    let choices = vec![
        ChoiceItem::pick(keep.0, KEEP_ANSWER, CommandsChoice::Keep)
            .with_hint(keep.1)
            .with_aliases(&["1"]),
        ChoiceItem::pick(remove.0, "remove", CommandsChoice::Remove)
            .with_hint(remove.1)
            .with_aliases(&["2"]),
    ];

    ask_choice(
        ChoiceQuestion {
            title,
            choices,
            index: 0,
            other: None,
            default_hint: None,
        },
        messages,
        ask,
    )
}

pub fn ask_our_statusline(
    restores: bool,
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<CommandsChoice> {
    let names = messages.statusline_ours_choices;
    let hints = messages.statusline_ours_hints;
    let remove_hint = if restores {
        hints.restore
    } else {
        hints.remove
    };

    keep_or_remove(
        (messages.statusline_ours_question)(&statusline_example(messages)),
        (names.keep, hints.keep),
        (names.remove, remove_hint),
        messages,
        ask,
    )
}

pub fn ask_installed_commands(
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<CommandsChoice> {
    let names = messages.bcct_choices;
    let hints = messages.bcct_hints;

    keep_or_remove(
        messages.bcct_installed_question.to_owned(),
        (names.keep, hints.keep),
        (names.remove, hints.remove),
        messages,
        ask,
    )
}

pub fn ask_pairing_choice(
    accounts: &str,
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<PairingChoice> {
    let names = messages.pairing_choices;
    let choices = vec![
        ChoiceItem::pick(names.keep, KEEP_ANSWER, PairingChoice::Keep).with_aliases(&NOT_ALIASES),
        ChoiceItem::pick(names.replace, "replace", PairingChoice::Replace)
            .with_aliases(&YES_ALIASES),
    ];

    ask_choice(
        ChoiceQuestion {
            title: (messages.pairing_choice_question)(accounts),
            choices,
            index: 0,
            other: None,
            default_hint: None,
        },
        messages,
        ask,
    )
}

pub fn ask_remove_models(
    others: &[&'static str],
    previous: Option<&'static str>,
    tag: &str,
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<Vec<&'static str>> {
    let mut choices = vec![
        ChoiceItem::pick(messages.remove_models_keep, KEEP_ANSWER, Vec::new())
            .with_aliases(&NOT_ALIASES),
    ];

    if others.len() > 1 {
        choices.push(ChoiceItem::pick(
            &(messages.remove_models_all)(&others.join(", ")),
            "all",
            others.to_vec(),
        ));
    }

    choices.extend(others.iter().map(|model| {
        let label = (messages.remove_model)(model);
        let label = if previous == Some(*model) {
            format!("{label} ({tag})")
        } else {
            label
        };

        ChoiceItem::pick(&label, model, vec![*model])
    }));

    ask_choice(
        ChoiceQuestion {
            title: messages.remove_models_question.to_owned(),
            choices,
            index: 0,
            other: None,
            default_hint: None,
        },
        messages,
        ask,
    )
}
