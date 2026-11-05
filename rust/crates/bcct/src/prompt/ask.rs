use std::io;

use super::{Answer, Choice, PromptError, Prompter};
use crate::js::{format_number, js_trim};
use crate::messages::Messages;
use crate::ui::{fail, question};

const UNDEFINED: &str = "undefined";

#[derive(Debug, Clone, PartialEq)]
pub enum ChoiceItem<T> {
    Heading(String),
    Pick {
        label: String,
        hint: Option<String>,
        previous: bool,
        answer: String,
        aliases: Vec<String>,
        value: T,
    },
}

impl<T> ChoiceItem<T> {
    #[must_use]
    pub fn pick(label: &str, answer: &str, value: T) -> Self {
        Self::Pick {
            label: label.to_owned(),
            hint: None,
            previous: false,
            answer: answer.to_owned(),
            aliases: Vec::new(),
            value,
        }
    }

    #[must_use]
    pub fn heading(label: &str) -> Self {
        Self::Heading(label.to_owned())
    }

    #[must_use]
    pub fn with_hint(mut self, shown: &str) -> Self {
        if let Self::Pick { hint, .. } = &mut self {
            *hint = Some(shown.to_owned());
        }

        self
    }

    #[must_use]
    pub fn with_aliases(mut self, names: &[&str]) -> Self {
        if let Self::Pick { aliases, .. } = &mut self {
            *aliases = names.iter().map(|name| (*name).to_owned()).collect();
        }

        self
    }

    #[must_use]
    pub fn map_value<U>(self, wrap: impl FnOnce(T) -> U) -> ChoiceItem<U> {
        match self {
            Self::Heading(label) => ChoiceItem::Heading(label),
            Self::Pick {
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
                value: wrap(value),
            },
        }
    }

    #[must_use]
    pub fn label(&self) -> &str {
        match self {
            Self::Heading(label) | Self::Pick { label, .. } => label,
        }
    }

    #[must_use]
    pub fn value(&self) -> Option<&T> {
        match self {
            Self::Heading(_) => None,
            Self::Pick { value, .. } => Some(value),
        }
    }

    fn answer(&self) -> Option<&str> {
        match self {
            Self::Heading(_) => None,
            Self::Pick { answer, .. } => Some(answer),
        }
    }

    fn answers_to(&self, typed: &str) -> bool {
        match self {
            Self::Heading(_) => false,
            Self::Pick {
                answer, aliases, ..
            } => answer == typed || aliases.iter().any(|alias| alias == typed),
        }
    }

    #[must_use]
    pub fn choice(&self) -> Choice {
        match self {
            Self::Heading(label) => Choice::heading(label),
            Self::Pick {
                label,
                hint,
                previous,
                ..
            } => Choice {
                label: label.clone(),
                hint: hint.clone(),
                heading: false,
                previous: *previous,
            },
        }
    }

    fn tagged(self, tags: &[String], now_previous: bool) -> Self {
        let suffix = format!(" ({})", tags.join(", "));

        match self {
            Self::Heading(label) => Self::Heading(format!("{label}{suffix}")),
            Self::Pick {
                label,
                hint,
                answer,
                aliases,
                value,
                ..
            } => Self::Pick {
                label: format!("{label}{suffix}"),
                hint,
                previous: now_previous,
                answer,
                aliases,
                value,
            },
        }
    }
}

pub struct Other<'a, T> {
    pub label: String,
    pub answer: String,
    pub parse: &'a dyn Fn(&str) -> Option<T>,
    pub ask_on_terminal: &'a mut dyn FnMut(&mut dyn Prompter) -> Answer<T>,
}

impl<T> std::fmt::Debug for Other<'_, T> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Other")
            .field("label", &self.label)
            .field("answer", &self.answer)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub struct ChoiceQuestion<'a, T> {
    pub title: String,
    pub choices: Vec<ChoiceItem<T>>,
    pub index: usize,
    pub other: Option<Other<'a, T>>,
    pub default_hint: Option<fn(&str) -> String>,
}

fn no_value() -> PromptError {
    PromptError::Io(io::Error::from(io::ErrorKind::InvalidInput))
}

fn value_at<T: Clone>(choices: &[ChoiceItem<T>], index: usize) -> Answer<T> {
    choices
        .get(index)
        .and_then(ChoiceItem::value)
        .cloned()
        .ok_or_else(no_value)
}

fn typed_answer(
    ask: &mut dyn Prompter,
    prompt: &str,
    messages: &'static Messages,
) -> Answer<String> {
    let colorize = ask.colors().out;
    let typed = ask.line(&question(prompt, colorize), messages)?;

    Ok(js_trim(&typed).to_owned())
}

fn complain(ask: &mut dyn Prompter, text: &str) -> Answer<()> {
    let line = fail(text, ask.colors().err);

    ask.report(&line)?;
    Ok(())
}

pub fn ask_yes_no(
    prompt: &str,
    messages: &'static Messages,
    default_yes: bool,
    ask: &mut dyn Prompter,
) -> Answer<bool> {
    if ask.interactive() {
        let title = question(prompt, ask.colors().out);
        let choices = [Choice::new(messages.yes), Choice::new(messages.no)];
        let chosen = ask.select(&title, &choices, usize::from(!default_yes), messages)?;

        return Ok(chosen == 0);
    }

    let hint = (messages.yes_no_hint)(default_yes);
    let answer = typed_answer(ask, &format!("{prompt} {hint} "), messages)?.to_lowercase();

    if answer.is_empty() {
        return Ok(default_yes);
    }

    Ok(answer.starts_with('s') || answer.starts_with('y'))
}

pub fn ask_hidden(
    prompt: &str,
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<String> {
    let title = question(prompt, ask.colors().out);

    ask.hidden(&title, messages)
}

pub fn ask_validated<T>(
    prompt: &str,
    parse: &dyn Fn(&str) -> Option<T>,
    hint: &str,
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<T> {
    loop {
        let typed = typed_answer(ask, prompt, messages)?;

        if let Some(value) = parse(&typed) {
            return Ok(value);
        }

        complain(ask, &(messages.invalid_answer)(&typed, hint))?;
    }
}

pub fn ask_choice<T: Clone>(
    spec: ChoiceQuestion<'_, T>,
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<T> {
    let ChoiceQuestion {
        title,
        choices,
        index,
        mut other,
        default_hint,
    } = spec;

    if ask.interactive() {
        let mut options: Vec<Choice> = choices.iter().map(ChoiceItem::choice).collect();

        if let Some(other) = &other {
            options.push(Choice::new(&other.label));
        }

        let shown = question(&title, ask.colors().out);
        let picked = ask.select(&shown, &options, index, messages)?;

        return match other.as_mut() {
            Some(other) if picked == choices.len() => (other.ask_on_terminal)(ask),
            _ => value_at(&choices, picked),
        };
    }

    let answers = choices
        .iter()
        .filter_map(ChoiceItem::answer)
        .chain(other.as_ref().map(|other| other.answer.as_str()))
        .collect::<Vec<_>>()
        .join(", ");
    let shown_default = choices
        .get(index)
        .and_then(ChoiceItem::answer)
        .unwrap_or(UNDEFINED);
    let hint = default_hint.unwrap_or(messages.default_hint)(shown_default);
    let prompt = format!("{title} ({answers}) {hint}: ");

    loop {
        let typed = typed_answer(ask, &prompt, messages)?.to_lowercase();

        if typed.is_empty() {
            return value_at(&choices, index);
        }

        if let Some(found) = choices.iter().find(|choice| choice.answers_to(&typed)) {
            return found.value().cloned().ok_or_else(no_value);
        }

        if let Some(value) = other.as_ref().and_then(|other| (other.parse)(&typed)) {
            return Ok(value);
        }

        complain(ask, &(messages.invalid_answer)(&typed, &answers))?;
    }
}

fn same_value_zero(left: f64, right: f64) -> bool {
    left.partial_cmp(&right)
        .is_some_and(std::cmp::Ordering::is_eq)
        || (left.is_nan() && right.is_nan())
}

#[must_use]
pub fn number_choices(
    presets: &[f64],
    current: Option<f64>,
    label: &dyn Fn(f64) -> String,
) -> Vec<ChoiceItem<f64>> {
    let mut values = presets.to_vec();

    if let Some(current) = current
        && !presets
            .iter()
            .any(|preset| same_value_zero(*preset, current))
    {
        values.push(current);
        values.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    }

    values
        .into_iter()
        .map(|value| ChoiceItem::pick(&label(value), &format_number(value), value))
        .collect()
}

#[must_use]
pub fn index_of_value<T: PartialEq>(choices: &[ChoiceItem<T>], current: &T) -> usize {
    choices
        .iter()
        .position(|choice| choice.value() == Some(current))
        .unwrap_or_default()
}

#[must_use]
pub fn marked<T>(
    choices: Vec<ChoiceItem<T>>,
    index: usize,
    saved: bool,
    tags_of: &dyn Fn(&ChoiceItem<T>) -> Vec<String>,
    messages: &'static Messages,
) -> Vec<ChoiceItem<T>> {
    choices
        .into_iter()
        .enumerate()
        .map(|(position, choice)| {
            let previous = saved && position == index;
            let mut tags = tags_of(&choice);

            if previous {
                tags.push(messages.previous_choice.to_owned());
            }

            if tags.is_empty() {
                choice
            } else {
                choice.tagged(&tags, previous)
            }
        })
        .collect()
}
