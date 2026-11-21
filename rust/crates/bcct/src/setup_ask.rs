use crate::config::{DEFAULT_DELAY_MINUTES, DelayKind, VisualMode, Visuals, kind_minutes};
use crate::install::{
    BASE_MODEL, CommandsChoice, DISABLE_ANSWERS, Parsed, SMALL_MODEL, TRANSCRIPTION_MODELS,
    TranscriptionChoice, VisualsPick,
};
use crate::js::{format_number, is_js_whitespace, js_number, js_trim};
use crate::locale::Locale;
use crate::messages::{Messages, format_delay};
use crate::prompt::{
    Answer, ChoiceItem, ChoiceQuestion, Other, Own, PromptError, Prompter, ask_choice,
    ask_choice_then, ask_validated, index_of_value, marked, number_choices, with_own,
};
use crate::setup_files::StatuslineChoice;
use crate::setup_telegram::PairingChoice;

pub type QuietRange = (String, String);

const DELAY_PRESETS: [f64; 7] = [0.0, 1.0, 3.0, 4.0, 5.0, 10.0, 15.0];
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
const REVIEW_ANSWERS: [&str; 6] = ["on", "review", "s", "y", "sim", "yes"];
const DIRECT_ANSWERS: [&str; 6] = ["off", "direct", "n", "no", "não", "nao"];
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

    (!trimmed.is_empty() && minutes.is_finite() && minutes >= 0.0).then_some(minutes)
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
pub fn parse_visual_mode(answer: &str) -> Option<VisualMode> {
    let typed = js_trim(answer).to_lowercase();

    if DISABLE_ANSWERS.contains(&typed.as_str()) {
        Some(VisualMode::Off)
    } else {
        VisualMode::parse(&typed)
    }
}

#[must_use]
pub fn parse_visual_review(answer: &str) -> Option<bool> {
    let typed = js_trim(answer).to_lowercase();

    if REVIEW_ANSWERS.contains(&typed.as_str()) {
        Some(true)
    } else if DIRECT_ANSWERS.contains(&typed.as_str()) {
        Some(false)
    } else {
        None
    }
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

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DelayPick {
    Minutes(f64),
    Kinds([f64; 3]),
}

#[must_use]
pub fn delay_text(minutes: f64, messages: &Messages) -> String {
    if minutes == 0.0 {
        messages.delay_right_away.to_owned()
    } else {
        format_delay(minutes)
    }
}

#[must_use]
pub fn kinds_summary(kinds: [f64; 3], messages: &Messages) -> String {
    messages
        .delay_kind_labels
        .iter()
        .zip(kinds)
        .map(|(label, minutes)| {
            format!("{} {}", label.to_lowercase(), delay_text(minutes, messages))
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

#[must_use]
pub fn parse_kinds(answer: &str) -> Option<[f64; 3]> {
    let parts: Vec<f64> = answer
        .split('/')
        .map(parse_delay_minutes)
        .collect::<Option<_>>()?;

    parts.try_into().ok()
}

#[must_use]
pub fn single_delay(kinds: [f64; 3]) -> Option<f64> {
    let [first, ..] = kinds;

    kinds
        .iter()
        .all(|minutes| {
            minutes
                .partial_cmp(&first)
                .is_some_and(std::cmp::Ordering::is_eq)
        })
        .then_some(first)
}

#[must_use]
pub fn saved_kinds(
    config: &serde_json::Map<String, serde_json::Value>,
    base: f64,
) -> Option<[f64; 3]> {
    config
        .get("delays")
        .filter(|delays| delays.is_object())
        .map(|_| DelayKind::ALL.map(|kind| kind_minutes(config, kind).unwrap_or(base)))
}

pub fn ask_delay(
    current: f64,
    saved: bool,
    kinds: Option<[f64; 3]>,
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<DelayPick> {
    let mut options: Vec<ChoiceItem<DelayPick>> =
        number_choices(&DELAY_PRESETS, Some(current), &|minutes| {
            if minutes == 0.0 {
                messages.delay_right_away_label.to_owned()
            } else {
                (messages.delay_label)(minutes)
            }
        })
        .into_iter()
        .map(|choice| choice.map_value(DelayPick::Minutes))
        .collect();
    let index = if kinds.is_some() {
        options.len()
    } else {
        index_of_value(&options, &DelayPick::Minutes(current))
    };
    let recommended = |choice: &ChoiceItem<DelayPick>| {
        if choice.value() == Some(&DelayPick::Minutes(DEFAULT_DELAY_MINUTES)) {
            vec![messages.recommended.to_owned()]
        } else {
            Vec::new()
        }
    };
    let parse_minutes = |answer: &str| parse_delay_minutes(answer).map(DelayPick::Minutes);
    let mut typed = |terminal: &mut dyn Prompter| {
        ask_validated(
            messages.delay_custom_prompt,
            &parse_minutes,
            messages.delay_custom_hint,
            messages,
            terminal,
        )
    };
    let info = kinds.map_or_else(
        || messages.delay_kinds_info.to_owned(),
        |kinds| kinds_summary(kinds, messages),
    );

    options.push(
        ChoiceItem::pick(
            messages.delay_per_kind,
            messages.delay_per_kind_answer,
            DelayPick::Kinds(kinds.unwrap_or([current; 3])),
        )
        .with_hint(&info),
    );

    let mut per_kind = |pick: DelayPick, terminal: &mut dyn Prompter| match pick {
        DelayPick::Kinds(start) => ask_delay_kinds(start, messages, terminal).map(DelayPick::Kinds),
        minutes @ DelayPick::Minutes(_) => Ok(minutes),
    };

    ask_choice_then(
        ChoiceQuestion {
            title: messages.delay_question.to_owned(),
            choices: marked(options, index, saved, &recommended, messages),
            index,
            other: Some(Other {
                label: messages.custom.to_owned(),
                answer: OTHER_ANSWER.to_owned(),
                parse: &parse_minutes,
                ask_on_terminal: &mut typed,
            }),
            default_hint: None,
        },
        Some(&mut per_kind),
        messages,
        ask,
    )
}

pub fn ask_delay_kinds(
    current: [f64; 3],
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<[f64; 3]> {
    let mut kinds = current;
    let mut position = 0;

    while let (Some(label), Some(slot)) = (
        messages.delay_kind_labels.get(position),
        kinds.get_mut(position),
    ) {
        let keep = *slot;
        let parse = |answer: &str| {
            if js_trim(answer).is_empty() {
                Some(keep)
            } else {
                parse_delay_minutes(answer)
            }
        };
        let answer = ask_validated(
            &(messages.delay_kind_prompt)(label),
            &parse,
            messages.delay_kind_hint,
            messages,
            ask,
        );

        match answer {
            Ok(minutes) => {
                *slot = minutes;
                position += 1;
            }
            Err(PromptError::Back) if position > 0 => position -= 1,
            Err(error) => return Err(error),
        }
    }

    Ok(kinds)
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

fn visual_mode_label(mode: VisualMode, messages: &Messages) -> &'static str {
    let [off, prints, video] = messages.visuals_labels;

    match mode {
        VisualMode::Off => off,
        VisualMode::Prints => prints,
        VisualMode::Video => video,
    }
}

pub fn ask_visual_review(
    current: bool,
    saved: bool,
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<bool> {
    let [review_label, direct_label] = messages.visual_review_labels;
    let options = vec![
        ChoiceItem::pick(review_label, "review", true).with_aliases(&REVIEW_ANSWERS),
        ChoiceItem::pick(direct_label, "direct", false).with_aliases(&DIRECT_ANSWERS),
    ];
    let index = index_of_value(&options, &current);

    ask_choice(
        ChoiceQuestion {
            title: messages.visual_review_question.to_owned(),
            choices: marked(options, index, saved, &|_| Vec::new(), messages),
            index,
            other: None,
            default_hint: None,
        },
        messages,
        ask,
    )
}

pub fn ask_visuals(
    current: Visuals,
    saved: bool,
    review_saved: bool,
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<VisualsPick> {
    let options: Vec<ChoiceItem<VisualsPick>> = VisualMode::ALL
        .into_iter()
        .map(|mode| {
            let item = ChoiceItem::pick(
                visual_mode_label(mode, messages),
                mode.key(),
                VisualsPick { mode, review: None },
            );

            if mode == VisualMode::Off {
                item.with_aliases(&DISABLE_ANSWERS)
            } else {
                item
            }
        })
        .collect();
    let index = index_of_value(
        &options,
        &VisualsPick {
            mode: current.mode,
            review: None,
        },
    );
    let mut follow_up = |pick: VisualsPick, terminal: &mut dyn Prompter| {
        if pick.mode == VisualMode::Off {
            return Ok(pick);
        }

        ask_visual_review(current.review, review_saved, messages, terminal).map(|review| {
            VisualsPick {
                review: Some(review),
                ..pick
            }
        })
    };

    ask_choice_then(
        ChoiceQuestion {
            title: messages.visuals_question.to_owned(),
            choices: marked(options, index, saved, &|_| Vec::new(), messages),
            index,
            other: None,
            default_hint: None,
        },
        Some(&mut follow_up),
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
    let presets = labels
        .into_iter()
        .zip(QUIET_RANGES)
        .map(|(label, (start, end))| {
            let answer = format!("{start}-{end}");

            ChoiceItem::pick(label, &answer, Some((start.to_owned(), end.to_owned())))
                .with_hint(&answer)
        });
    let off =
        ChoiceItem::pick(messages.quiet_off_label, OFF_ANSWER, None).with_aliases(&DISABLE_ANSWERS);
    let options = with_own(
        [off].into_iter().chain(presets).collect(),
        current.cloned(),
        &Own {
            same: &PartialEq::eq,
            item: &|_, own| {
                own.map(|own| {
                    let text = range_text(&own);

                    (1, ChoiceItem::pick(&text, &text, Some(own)))
                })
            },
        },
    );
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
        BASE_MODEL => models.base,
        SMALL_MODEL => models.small,
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
            TranscriptionChoice::Uninstall(Vec::new()),
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
    let in_use = current.filter(|_| saved);
    let mut removal = |choice: TranscriptionChoice, terminal: &mut dyn Prompter| match choice {
        TranscriptionChoice::Uninstall(_) if installed.len() == 1 => {
            Ok(TranscriptionChoice::Uninstall(installed.to_vec()))
        }
        TranscriptionChoice::Uninstall(_) => {
            ask_remove_models(installed, in_use, messages.model_in_use, messages, terminal)
                .map(TranscriptionChoice::Uninstall)
        }
        other => Ok(other),
    };

    ask_choice_then(
        ChoiceQuestion {
            title: messages.transcription_question.to_owned(),
            choices: marked(options, index, saved, &|_| Vec::new(), messages),
            index,
            other: None,
            default_hint: None,
        },
        Some(&mut removal),
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

#[cfg(test)]
mod delay_tests {
    use super::*;
    use crate::messages::{EN_US, PT_BR};
    use crate::prompt::{FakeCall, FakePrompter, Reply};

    fn per_kind_choice(ask: &FakePrompter) -> crate::prompt::Choice {
        let (choices, _) = ask.calls()[0].select().unwrap();

        choices[choices.len() - 2].clone()
    }

    #[test]
    fn marks_the_preset_as_current_when_a_typed_value_matches_it() {
        let mut ask = FakePrompter::new(true).with_replies([Reply::Default, Reply::Default]);

        ask_delay(5.0, true, None, &PT_BR, &mut ask).unwrap();
        ask_delay(0.0, true, None, &PT_BR, &mut ask).unwrap();

        for call in ask.calls() {
            let (choices, index) = call.select().unwrap();

            assert_eq!(choices.len(), DELAY_PRESETS.len() + 2);
            assert!(choices[index].previous);
        }
    }

    #[test]
    fn offers_right_away_first_and_takes_a_typed_zero() {
        let mut ask = FakePrompter::new(true).with_replies([Reply::Choose(0)]);
        let mut typed = FakePrompter::new(false).with_replies([Reply::Text("0".to_owned())]);

        let picked = ask_delay(4.0, true, None, &PT_BR, &mut ask).unwrap();
        let first = ask.calls()[0].select().unwrap().0[0].label.clone();

        assert_eq!(picked, DelayPick::Minutes(0.0));
        assert_eq!(first, "Na hora");
        assert_eq!(
            ask_delay(4.0, true, None, &PT_BR, &mut typed).unwrap(),
            DelayPick::Minutes(0.0)
        );
    }

    #[test]
    fn offers_per_kind_before_custom_with_the_kinds_beside_it() {
        let mut ask = FakePrompter::new(true).with_replies([Reply::Choose(7)]);

        let picked = ask_delay(4.0, true, None, &PT_BR, &mut ask).unwrap();
        let shown = per_kind_choice(&ask);

        assert_eq!(picked, DelayPick::Kinds([4.0; 3]));
        assert_eq!(shown.label, "Por tipo…");
        assert_eq!(
            shown.hint.as_deref(),
            Some("perguntas, permissões e aviso de espera")
        );
    }

    #[test]
    fn keeps_per_kind_as_the_default_when_saved_with_its_values_beside_it() {
        let mut ask = FakePrompter::new(true).with_replies([
            Reply::Default,
            Reply::Text(String::new()),
            Reply::Text(String::new()),
            Reply::Text(String::new()),
            Reply::Choose(3),
        ]);

        let kept = ask_delay(4.0, true, Some([0.0, 4.0, 1.5]), &EN_US, &mut ask).unwrap();
        let single = ask_delay(4.0, true, Some([0.0, 4.0, 1.5]), &EN_US, &mut ask).unwrap();

        assert_eq!(kept, DelayPick::Kinds([0.0, 4.0, 1.5]));
        assert_eq!(single, DelayPick::Minutes(4.0));
        assert!(per_kind_choice(&ask).previous);
        assert_eq!(
            per_kind_choice(&ask).hint.as_deref(),
            Some("questions right away · permission requests 4 min · waiting notice 1 min 30 s")
        );
    }

    #[test]
    fn takes_the_typed_kind_answer_or_minutes_without_a_terminal() {
        let mut ask = FakePrompter::new(false).with_replies([
            Reply::Text("tipo".to_owned()),
            Reply::Text("0".to_owned()),
            Reply::Text(String::new()),
            Reply::Text("10".to_owned()),
            Reply::Text("7".to_owned()),
        ]);

        assert_eq!(
            ask_delay(4.0, true, None, &PT_BR, &mut ask).unwrap(),
            DelayPick::Kinds([0.0, 4.0, 10.0])
        );
        assert!(ask.calls().iter().all(|call| {
            call.line()
                .is_none_or(|prompt| !prompt.contains("Esc volta"))
        }));
        assert_eq!(
            ask_delay(4.0, true, None, &PT_BR, &mut ask).unwrap(),
            DelayPick::Minutes(7.0)
        );
    }

    #[test]
    fn asks_each_kind_keeping_the_current_value_on_an_empty_answer() {
        let mut ask = FakePrompter::new(false).with_replies([
            Reply::Text("0".to_owned()),
            Reply::Text(String::new()),
            Reply::Text("-1".to_owned()),
            Reply::Text("2,5".to_owned()),
        ]);

        let kinds = ask_delay_kinds([4.0, 4.0, 4.0], &PT_BR, &mut ask).unwrap();
        let prompts: Vec<&str> = ask.calls().iter().filter_map(FakeCall::line).collect();

        assert_eq!(kinds, [0.0, 4.0, 2.5]);
        assert_eq!(prompts.len(), 4);
        assert!(prompts[0].contains("Perguntas, em minutos (0 = na hora): "));
        assert!(prompts[2].contains("Aviso de espera, em minutos (0 = na hora): "));
        assert_eq!(ask.reports().len(), 1);
    }

    #[test]
    fn describes_zero_as_right_away_and_the_rest_like_the_channel() {
        assert_eq!(delay_text(0.0, &PT_BR), "na hora");
        assert_eq!(delay_text(4.0, &PT_BR), "4 min");
        assert_eq!(delay_text(0.1, &EN_US), "6 s");
    }

    #[test]
    fn merges_the_kinds_into_one_delay_only_when_all_match() {
        assert_eq!(single_delay([4.0, 4.0, 4.0]), Some(4.0));
        assert_eq!(single_delay([0.0, 0.0, 0.0]), Some(0.0));
        assert_eq!(single_delay([2.5, 2.5, 2.5]), Some(2.5));
        assert_eq!(single_delay([4.0, 4.0, 5.0]), None);
        assert_eq!(single_delay([0.0, 4.0, 4.0]), None);
        assert_eq!(single_delay([4.0, 3.0, 4.0]), None);
    }
}

#[cfg(test)]
mod repeated_option_tests {
    use super::*;
    use crate::messages::PT_BR;
    use crate::prompt::{Choice, FakePrompter, Reply};

    fn shown(ask: &FakePrompter) -> (Vec<Choice>, usize) {
        let (choices, index) = ask.calls()[0].select().unwrap();

        (choices.to_vec(), index)
    }

    fn starting_with(choices: &[Choice], label: &str) -> usize {
        choices
            .iter()
            .filter(|choice| choice.label.starts_with(label))
            .count()
    }

    fn current_is(choices: &[Choice], index: usize, label: &str) {
        assert!(choices[index].label.starts_with(label), "{choices:?}");
        assert!(choices[index].previous);
        assert_eq!(choices.iter().filter(|choice| choice.previous).count(), 1);
    }

    #[test]
    fn marks_the_inbox_preset_as_current_when_a_typed_value_matches_it() {
        let mut ask = FakePrompter::new(true).with_replies([Reply::Default]);

        ask_inbox(Some(7.0), true, &PT_BR, &mut ask).unwrap();
        let (choices, index) = shown(&ask);

        assert_eq!(choices.len(), INBOX_PRESETS.len() + 2);
        current_is(&choices, index, &inbox_label(&PT_BR, 7.0));
    }

    #[test]
    fn lists_an_inbox_value_of_its_own_once_beside_the_presets() {
        let mut ask = FakePrompter::new(true).with_replies([Reply::Default]);

        ask_inbox(Some(2.0), true, &PT_BR, &mut ask).unwrap();
        let (choices, index) = shown(&ask);
        let own = inbox_label(&PT_BR, 2.0);

        assert_eq!(choices.len(), INBOX_PRESETS.len() + 3);
        assert_eq!(starting_with(&choices, &own), 1);
        current_is(&choices, index, &own);
    }

    #[test]
    fn marks_the_quiet_preset_as_current_when_a_typed_range_matches_it() {
        let mut ask = FakePrompter::new(true).with_replies([Reply::Default]);
        let range = ("00:00".to_owned(), "07:00".to_owned());

        ask_quiet_hours(Some(&range), true, &PT_BR, &mut ask).unwrap();
        let (choices, index) = shown(&ask);

        assert_eq!(choices.len(), QUIET_RANGES.len() + 2);
        assert_eq!(starting_with(&choices, "00:00-07:00"), 0);
        current_is(&choices, index, PT_BR.quiet_presets.late_night);
    }

    #[test]
    fn lists_a_quiet_range_of_its_own_once_beside_the_presets() {
        let mut ask = FakePrompter::new(true).with_replies([Reply::Default]);
        let range = ("01:00".to_owned(), "06:00".to_owned());

        ask_quiet_hours(Some(&range), true, &PT_BR, &mut ask).unwrap();
        let (choices, index) = shown(&ask);

        assert_eq!(choices.len(), QUIET_RANGES.len() + 3);
        assert_eq!(starting_with(&choices, "01:00-06:00"), 1);
        current_is(&choices, index, "01:00-06:00");
    }

    #[test]
    fn keeps_the_typed_quiet_range_as_the_preset_it_matches() {
        let mut terminal = FakePrompter::new(true).with_replies([
            Reply::Choose(QUIET_RANGES.len() + 1),
            Reply::Text("0:00".to_owned()),
            Reply::Text("7:00".to_owned()),
            Reply::End,
        ]);
        let late_night = Some(("00:00".to_owned(), "07:00".to_owned()));

        assert_eq!(quiet_answer(" 00:00 - 07:00 "), Some(late_night.clone()));
        assert_eq!(
            ask_quiet_hours(None, false, &PT_BR, &mut terminal).unwrap(),
            late_night
        );
    }
}

#[cfg(test)]
mod back_tests {
    use super::*;
    use crate::messages::PT_BR;
    use crate::prompt::{FakeCall, FakePrompter, Reply, with_back};

    const BACK_HINT: &str = " · ← ou Esc volta: ";

    fn selects(ask: &FakePrompter) -> Vec<(usize, Vec<String>)> {
        ask.calls()
            .iter()
            .filter_map(FakeCall::select)
            .map(|(choices, index)| {
                (
                    index,
                    choices.iter().map(|choice| choice.label.clone()).collect(),
                )
            })
            .collect()
    }

    fn lines(ask: &FakePrompter) -> Vec<String> {
        ask.calls()
            .iter()
            .filter_map(FakeCall::line)
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn goes_back_to_the_list_from_the_custom_delay_with_the_cursor_on_it() {
        let custom = DELAY_PRESETS.len() + 1;
        let mut ask = FakePrompter::new(true).with_replies([
            Reply::Choose(custom),
            Reply::Back,
            Reply::Choose(3),
        ]);

        assert_eq!(
            ask_delay(4.0, true, None, &PT_BR, &mut ask).unwrap(),
            DelayPick::Minutes(4.0)
        );
        assert_eq!(selects(&ask).len(), 2);
        assert_eq!(selects(&ask)[1].0, custom);
        assert_eq!(lines(&ask), [format!("Minutos (0 = na hora){BACK_HINT}")]);
        assert!(!ask.back());
    }

    #[test]
    fn steps_back_one_kind_keeping_what_was_typed() {
        let mut ask = FakePrompter::new(true).with_replies([
            Reply::Choose(7),
            Reply::Text("0".to_owned()),
            Reply::Back,
            Reply::Text(String::new()),
            Reply::Text("5".to_owned()),
            Reply::Text("10".to_owned()),
        ]);

        assert_eq!(
            ask_delay(4.0, true, None, &PT_BR, &mut ask).unwrap(),
            DelayPick::Kinds([0.0, 5.0, 10.0])
        );

        let prompts = lines(&ask);

        assert_eq!(prompts.len(), 5);
        assert_eq!(prompts[0], prompts[2]);
        assert!(prompts[0].starts_with("Perguntas"));
        assert!(prompts.iter().all(|prompt| prompt.ends_with(BACK_HINT)));
    }

    #[test]
    fn goes_back_to_the_list_from_the_first_kind() {
        let mut ask =
            FakePrompter::new(true).with_replies([Reply::Choose(7), Reply::Back, Reply::Choose(0)]);

        assert_eq!(
            ask_delay(4.0, true, None, &PT_BR, &mut ask).unwrap(),
            DelayPick::Minutes(0.0)
        );
        assert_eq!(selects(&ask)[1].0, 7);
    }

    #[test]
    fn goes_back_to_the_list_from_the_custom_inbox_and_quiet_hours() {
        let inbox_custom = INBOX_PRESETS.len() + 1;
        let quiet_custom = QUIET_RANGES.len() + 1;
        let mut inbox = FakePrompter::new(true).with_replies([
            Reply::Choose(inbox_custom),
            Reply::Back,
            Reply::Choose(2),
        ]);
        let mut quiet = FakePrompter::new(true).with_replies([
            Reply::Choose(quiet_custom),
            Reply::Text("01:00".to_owned()),
            Reply::Back,
            Reply::Choose(0),
        ]);

        assert_eq!(
            ask_inbox(None, false, &PT_BR, &mut inbox).unwrap(),
            Some(7.0)
        );
        assert_eq!(selects(&inbox)[1].0, inbox_custom);
        assert_eq!(
            ask_quiet_hours(None, false, &PT_BR, &mut quiet).unwrap(),
            None
        );
        assert_eq!(selects(&quiet)[1].0, quiet_custom);
        assert_eq!(lines(&quiet).len(), 2);
    }

    #[test]
    fn offers_back_only_in_a_list_opened_by_an_option() {
        let models = ["base", "small"];
        let mut plain = FakePrompter::new(true).with_replies([Reply::Default]);
        let mut opened = FakePrompter::new(true).with_replies([Reply::Last]);

        ask_remove_models(&models, None, "x", &PT_BR, &mut plain).unwrap();

        let answer = with_back(&mut opened, |ask| {
            ask_remove_models(&models, None, "x", &PT_BR, ask)
        });

        assert!(answer.unwrap_err().is_back());
        assert_ne!(selects(&plain)[0].1.last().unwrap(), "← Voltar");
        assert_eq!(selects(&opened)[0].1.last().unwrap(), "← Voltar");
        assert!(!opened.back());
    }
}

#[cfg(test)]
mod visuals_tests {
    use super::*;
    use crate::messages::{EN_US, PT_BR};
    use crate::prompt::{FakePrompter, Reply};

    fn visuals(mode: VisualMode, review: bool) -> Visuals {
        Visuals { mode, review }
    }

    fn pick(mode: VisualMode, review: Option<bool>) -> VisualsPick {
        VisualsPick { mode, review }
    }

    fn labels(ask: &FakePrompter, call: usize) -> Vec<String> {
        let (choices, _) = ask.calls()[call].select().unwrap();

        choices.iter().map(|choice| choice.label.clone()).collect()
    }

    #[test]
    fn lists_the_three_modes_and_asks_the_review_for_prints_and_video() {
        let mut ask = FakePrompter::new(true).with_replies([Reply::Choose(1), Reply::Choose(1)]);

        let answer = ask_visuals(
            visuals(VisualMode::Off, true),
            false,
            false,
            &PT_BR,
            &mut ask,
        )
        .unwrap();

        assert_eq!(answer, pick(VisualMode::Prints, Some(false)));
        assert_eq!(labels(&ask, 0), PT_BR.visuals_labels);
        assert_eq!(
            labels(&ask, 1),
            [
                PT_BR.visual_review_labels[0],
                PT_BR.visual_review_labels[1],
                "← Voltar"
            ]
        );
    }

    #[test]
    fn asks_no_review_when_the_visuals_go_off() {
        let mut ask = FakePrompter::new(true).with_replies([Reply::Choose(0)]);

        let answer = ask_visuals(
            visuals(VisualMode::Video, false),
            true,
            true,
            &EN_US,
            &mut ask,
        )
        .unwrap();

        assert_eq!(answer, pick(VisualMode::Off, None));
        assert_eq!(ask.calls().len(), 1);
    }

    #[test]
    fn preselects_the_saved_mode_and_the_saved_review() {
        let mut ask = FakePrompter::new(true).with_replies([Reply::Default, Reply::Default]);

        let answer = ask_visuals(
            visuals(VisualMode::Video, false),
            true,
            true,
            &EN_US,
            &mut ask,
        )
        .unwrap();
        let (modes, mode_index) = ask.calls()[0].select().unwrap();
        let (reviews, review_index) = ask.calls()[1].select().unwrap();

        assert_eq!(answer, pick(VisualMode::Video, Some(false)));
        assert_eq!(mode_index, 2);
        assert!(modes[2].previous);
        assert_eq!(review_index, 1);
        assert!(reviews[1].previous);
    }

    #[test]
    fn preselects_the_default_without_marking_it_when_nothing_is_saved() {
        let mut ask = FakePrompter::new(true).with_replies([Reply::Default]);

        ask_visuals(
            visuals(VisualMode::Off, true),
            false,
            false,
            &EN_US,
            &mut ask,
        )
        .unwrap();
        let (modes, index) = ask.calls()[0].select().unwrap();

        assert_eq!(index, 0);
        assert!(modes.iter().all(|choice| !choice.previous));
    }

    #[test]
    fn goes_back_to_the_list_from_the_review_with_the_cursor_on_the_mode() {
        let mut ask =
            FakePrompter::new(true).with_replies([Reply::Choose(2), Reply::Back, Reply::Choose(0)]);

        let answer = ask_visuals(
            visuals(VisualMode::Off, true),
            false,
            false,
            &EN_US,
            &mut ask,
        )
        .unwrap();

        assert_eq!(answer, pick(VisualMode::Off, None));
        assert_eq!(ask.calls()[2].select().unwrap().1, 2);
        assert!(!ask.back());
    }

    #[test]
    fn takes_the_typed_mode_and_the_typed_review_without_a_terminal() {
        let mut ask = FakePrompter::new(false).with_replies([
            Reply::Text("Video".to_owned()),
            Reply::Text("direct".to_owned()),
            Reply::Text("prints".to_owned()),
            Reply::Text(String::new()),
            Reply::Text("none".to_owned()),
        ]);
        let current = visuals(VisualMode::Off, true);

        assert_eq!(
            ask_visuals(current, false, false, &EN_US, &mut ask).unwrap(),
            pick(VisualMode::Video, Some(false))
        );
        assert_eq!(
            ask_visuals(current, false, false, &EN_US, &mut ask).unwrap(),
            pick(VisualMode::Prints, Some(true))
        );
        assert_eq!(
            ask_visuals(current, false, false, &EN_US, &mut ask).unwrap(),
            pick(VisualMode::Off, None)
        );
        assert!(
            ask.calls()[0]
                .line()
                .unwrap()
                .contains("(off, prints, video)")
        );
        assert!(ask.calls()[1].line().unwrap().contains("(review, direct)"));
        assert!(ask.calls()[3].line().unwrap().contains("[default: review]"));
    }

    #[test]
    fn asks_again_after_a_typed_mode_that_does_not_exist() {
        let mut ask = FakePrompter::new(false)
            .with_replies([Reply::Text("gif".to_owned()), Reply::Text("off".to_owned())]);

        assert_eq!(
            ask_visuals(
                visuals(VisualMode::Off, true),
                false,
                false,
                &EN_US,
                &mut ask
            )
            .unwrap(),
            pick(VisualMode::Off, None)
        );
        assert_eq!(ask.reports().len(), 1);
    }

    #[test]
    fn parses_the_mode_by_its_key_or_by_a_way_to_say_off() {
        assert_eq!(parse_visual_mode(" Prints "), Some(VisualMode::Prints));
        assert_eq!(parse_visual_mode("VIDEO"), Some(VisualMode::Video));

        for off in ["off", "no", "não", "none", "0", "n"] {
            assert_eq!(parse_visual_mode(off), Some(VisualMode::Off), "{off}");
        }

        for wrong in ["", "gif", "on", "screenshots"] {
            assert_eq!(parse_visual_mode(wrong), None, "{wrong}");
        }
    }

    #[test]
    fn parses_the_review_as_on_or_off_with_the_words_of_the_question() {
        for on in ["on", "review", " Yes ", "s", "y", "sim"] {
            assert_eq!(parse_visual_review(on), Some(true), "{on}");
        }

        for off in ["off", "direct", "NO", "n", "não", "nao"] {
            assert_eq!(parse_visual_review(off), Some(false), "{off}");
        }

        for wrong in ["", "maybe", "1"] {
            assert_eq!(parse_visual_review(wrong), None, "{wrong}");
        }
    }
}

#[cfg(test)]
mod transcription_tests {
    use super::*;
    use crate::messages::{EN_US, PT_BR};

    #[test]
    fn gives_each_transcription_model_the_hint_of_its_name() {
        for messages in [&EN_US, &PT_BR] {
            let models = messages.transcription_models;

            for (model, hint) in [
                ("base", models.base),
                ("small", models.small),
                ("medium", models.medium),
            ] {
                assert!(
                    matches!(
                        model_option(model, messages),
                        ChoiceItem::Pick { hint: Some(given), .. } if given == hint
                    ),
                    "{model}"
                );
            }
        }
    }
}
