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

pub fn with_back<T>(
    ask: &mut dyn Prompter,
    step: impl FnOnce(&mut dyn Prompter) -> Answer<T>,
) -> Answer<T> {
    let before = ask.back();

    ask.set_back(true);

    let answer = step(ask);

    ask.set_back(before);
    answer
}

#[must_use]
pub fn back_prompt(prompt: &str, hint: &str) -> String {
    let body = prompt.trim_end();

    body.strip_suffix(':').map_or_else(
        || format!("{body} ({hint}) "),
        |label| format!("{label} · {hint}{}", &prompt[label.len()..]),
    )
}

fn typed_answer(
    ask: &mut dyn Prompter,
    prompt: &str,
    messages: &'static Messages,
) -> Answer<String> {
    let colorize = ask.colors().out;
    let prompt = if ask.back() {
        back_prompt(prompt, messages.back_hint)
    } else {
        prompt.to_owned()
    };
    let typed = ask.line(&question(&prompt, colorize), messages)?;

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

pub type Then<'a, T> = dyn FnMut(T, &mut dyn Prompter) -> Answer<T> + 'a;

pub fn ask_choice<T: Clone>(
    spec: ChoiceQuestion<'_, T>,
    messages: &'static Messages,
    ask: &mut dyn Prompter,
) -> Answer<T> {
    ask_choice_then(spec, None, messages, ask)
}

pub fn ask_choice_then<T: Clone>(
    spec: ChoiceQuestion<'_, T>,
    mut then: Option<&mut Then<'_, T>>,
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

        let back_at = ask.back().then(|| {
            options.push(Choice::new(messages.back_label));
            options.len() - 1
        });
        let shown = question(&title, ask.colors().out);
        let mut index = index;

        loop {
            let picked = ask.select(&shown, &options, index, messages)?;

            if back_at == Some(picked) {
                return Err(PromptError::Back);
            }

            let answer = match other.as_mut() {
                Some(other) if picked == choices.len() => {
                    with_back(ask, |terminal| (other.ask_on_terminal)(terminal))
                }
                _ => {
                    let value = value_at(&choices, picked)?;

                    match then.as_mut() {
                        Some(then) => with_back(ask, |terminal| then(value, terminal)),
                        None => Ok(value),
                    }
                }
            };

            match answer {
                Err(PromptError::Back) => index = picked,
                answer => return answer,
            }
        }
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

        let found = if typed.is_empty() {
            choices.get(index)
        } else {
            choices.iter().find(|choice| choice.answers_to(&typed))
        };

        if let Some(found) = found {
            let value = found.value().cloned().ok_or_else(no_value)?;

            return match then.as_mut() {
                Some(then) => then(value, ask),
                None => Ok(value),
            };
        }

        if let Some(value) = other.as_ref().and_then(|other| (other.parse)(&typed)) {
            return Ok(value);
        }

        complain(ask, &(messages.invalid_answer)(&typed, &answers))?;
    }
}

pub type OwnItem<'a, T> = dyn Fn(&[ChoiceItem<T>], T) -> Option<(usize, ChoiceItem<T>)> + 'a;

pub struct Own<'a, T> {
    pub same: &'a dyn Fn(&T, &T) -> bool,
    pub item: &'a OwnItem<'a, T>,
}

impl<T> std::fmt::Debug for Own<'_, T> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Own").finish_non_exhaustive()
    }
}

fn same_value_zero(left: f64, right: f64) -> bool {
    left.partial_cmp(&right)
        .is_some_and(std::cmp::Ordering::is_eq)
        || (left.is_nan() && right.is_nan())
}

#[must_use]
pub fn with_own<T>(
    mut choices: Vec<ChoiceItem<T>>,
    current: T,
    own: &Own<'_, T>,
) -> Vec<ChoiceItem<T>> {
    if choices
        .iter()
        .filter_map(ChoiceItem::value)
        .any(|value| (own.same)(value, &current))
    {
        return choices;
    }

    let Own { item: build, .. } = own;

    if let Some((position, item)) = build(&choices, current) {
        choices.insert(position, item);
    }

    choices
}

#[must_use]
pub fn number_choices(
    presets: &[f64],
    current: Option<f64>,
    label: &dyn Fn(f64) -> String,
) -> Vec<ChoiceItem<f64>> {
    let pick = |value: f64| ChoiceItem::pick(&label(value), &format_number(value), value);
    let choices = presets.iter().map(|value| pick(*value)).collect();
    let Some(current) = current else {
        return choices;
    };

    let mut choices = with_own(
        choices,
        current,
        &Own {
            same: &|left, right| same_value_zero(*left, *right),
            item: &|choices, value| Some((choices.len(), pick(value))),
        },
    );

    if choices.len() > presets.len() {
        choices.sort_by(|left, right| {
            left.value()
                .partial_cmp(&right.value())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }

    choices
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

#[cfg(test)]
mod then_tests {
    use super::*;
    use crate::locale::Locale;
    use crate::messages::messages_for;
    use crate::prompt::{FakeCall, FakePrompter, Reply};

    fn messages() -> &'static Messages {
        messages_for(Locale::EnUs)
    }

    fn letters() -> Vec<ChoiceItem<char>> {
        vec![
            ChoiceItem::pick("a", "a", 'a'),
            ChoiceItem::pick("b", "b", 'b'),
        ]
    }

    fn question_of(
        choices: Vec<ChoiceItem<char>>,
        index: usize,
        other: Option<Other<'_, char>>,
    ) -> ChoiceQuestion<'_, char> {
        ChoiceQuestion {
            title: "Pick".to_owned(),
            choices,
            index,
            other,
            default_hint: None,
        }
    }

    fn parse_z(text: &str) -> Option<char> {
        (text == "z").then_some('z')
    }

    fn typed_z(ask: &mut dyn Prompter) -> Answer<char> {
        let text = ask.line("Letter: ", messages())?;

        Ok(text.chars().next().unwrap_or('z'))
    }

    fn other_with<'a>(
        parse: &'a dyn Fn(&str) -> Option<char>,
        ask_on_terminal: &'a mut dyn FnMut(&mut dyn Prompter) -> Answer<char>,
    ) -> Other<'a, char> {
        Other {
            label: "Other".to_owned(),
            answer: "z".to_owned(),
            parse,
            ask_on_terminal,
        }
    }

    fn labels(ask: &FakePrompter) -> Vec<&str> {
        ask.calls()
            .iter()
            .filter_map(FakeCall::select)
            .flat_map(|(choices, _)| choices.iter().map(|choice| choice.label.as_str()))
            .collect()
    }

    #[test]
    fn asks_on_the_terminal_when_the_other_option_is_picked() {
        let mut typed = typed_z;
        let mut ask = FakePrompter::new(true).with_replies([Reply::Choose(2)]);
        let other = other_with(&parse_z, &mut typed);

        let answer = ask_choice_then(
            question_of(letters(), 0, Some(other)),
            None,
            messages(),
            &mut ask,
        );

        assert_eq!(answer.unwrap(), 'z');
        assert_eq!(labels(&ask), ["a", "b", "Other"]);
    }

    #[test]
    fn returns_the_value_of_the_picked_choice() {
        let mut ask = FakePrompter::new(true).with_replies([Reply::Choose(1)]);

        let answer = ask_choice_then(question_of(letters(), 0, None), None, messages(), &mut ask);

        assert_eq!(answer.unwrap(), 'b');
        assert_eq!(labels(&ask), ["a", "b"]);
    }

    #[test]
    fn goes_back_when_the_back_option_is_picked() {
        let mut ask = FakePrompter::new(true).with_replies([Reply::Choose(2)]);

        ask.set_back(true);

        let answer = ask_choice_then(question_of(letters(), 0, None), None, messages(), &mut ask);

        assert!(matches!(answer, Err(PromptError::Back)));
        assert_eq!(labels(&ask), ["a", "b", messages().back_label]);
    }

    #[test]
    fn asks_the_choice_again_at_the_option_when_the_step_goes_back() {
        let mut seen = Vec::new();
        let mut step = |value: char, _: &mut dyn Prompter| {
            seen.push(value);

            if seen.len() == 1 {
                Err(PromptError::Back)
            } else {
                Ok(value.to_ascii_uppercase())
            }
        };
        let mut ask =
            FakePrompter::new(true).with_replies([Reply::Choose(1), Reply::Choose(1), Reply::End]);

        let answer = ask_choice_then(
            question_of(letters(), 0, None),
            Some(&mut step),
            messages(),
            &mut ask,
        );
        let indexes: Vec<usize> = ask
            .calls()
            .iter()
            .filter_map(FakeCall::select)
            .map(|(_, index)| index)
            .collect();

        assert_eq!(answer.unwrap(), 'B');
        assert_eq!(seen, ['b', 'b']);
        assert_eq!(indexes, [0, 1]);
    }

    #[test]
    fn fails_when_the_picked_choice_holds_no_value() {
        let choices = vec![ChoiceItem::heading("h"), ChoiceItem::pick("a", "a", 'a')];
        let mut ask = FakePrompter::new(true).with_replies([Reply::Choose(0)]);

        let answer = ask_choice_then(question_of(choices, 1, None), None, messages(), &mut ask);

        assert!(
            matches!(answer, Err(PromptError::Io(error)) if error.kind() == io::ErrorKind::InvalidInput)
        );
    }

    #[test]
    fn runs_the_step_on_the_typed_answer() {
        let mut step = |value: char, _: &mut dyn Prompter| Ok(value.to_ascii_uppercase());
        let mut ask = FakePrompter::new(false).with_replies([Reply::Text("b".to_owned())]);

        let answer = ask_choice_then(
            question_of(letters(), 0, None),
            Some(&mut step),
            messages(),
            &mut ask,
        );
        let prompt = ask
            .calls()
            .iter()
            .find_map(FakeCall::line)
            .unwrap()
            .to_owned();

        assert_eq!(answer.unwrap(), 'B');
        assert!(prompt.contains("(a, b)"), "{prompt}");
    }

    #[test]
    fn takes_the_default_choice_when_nothing_is_typed() {
        let mut ask = FakePrompter::new(false).with_replies([Reply::Text(String::new())]);

        let answer = ask_choice_then(question_of(letters(), 1, None), None, messages(), &mut ask);

        assert_eq!(answer.unwrap(), 'b');
    }

    #[test]
    fn fails_when_the_default_choice_holds_no_value() {
        let choices = vec![ChoiceItem::heading("h"), ChoiceItem::pick("a", "a", 'a')];
        let mut ask = FakePrompter::new(false).with_replies([Reply::Text(String::new())]);

        let answer = ask_choice_then(question_of(choices, 0, None), None, messages(), &mut ask);

        assert!(
            matches!(answer, Err(PromptError::Io(error)) if error.kind() == io::ErrorKind::InvalidInput)
        );
    }

    #[test]
    fn reports_the_answers_that_fit_nothing_and_parses_the_other_one() {
        let mut typed = typed_z;
        let mut ask = FakePrompter::new(false).with_replies([
            Reply::Text("q".to_owned()),
            Reply::Text("z".to_owned()),
            Reply::End,
        ]);
        let other = other_with(&parse_z, &mut typed);

        let answer = ask_choice_then(
            question_of(letters(), 0, Some(other)),
            None,
            messages(),
            &mut ask,
        );

        assert_eq!(answer.unwrap(), 'z');
        let reports = ask.reports();

        assert_eq!(reports.len(), 1);
        assert!(reports[0].contains("'q' is not valid"));
    }
}

#[cfg(test)]
mod own_tests {
    use super::*;

    fn letters() -> Vec<ChoiceItem<char>> {
        vec![
            ChoiceItem::heading("h"),
            ChoiceItem::pick("a", "a", 'a'),
            ChoiceItem::pick("c", "c", 'c'),
        ]
    }

    fn labels(choices: &[ChoiceItem<char>]) -> Vec<&str> {
        choices.iter().map(ChoiceItem::label).collect()
    }

    fn own_at_end(choices: &[ChoiceItem<char>], value: char) -> Option<(usize, ChoiceItem<char>)> {
        let text = value.to_string();

        (value != '-').then(|| (choices.len(), ChoiceItem::pick(&text, &text, value)))
    }

    #[test]
    fn adds_the_value_of_its_own_only_when_no_option_has_it() {
        let own = Own {
            same: &PartialEq::eq,
            item: &own_at_end,
        };

        assert_eq!(labels(&with_own(letters(), 'a', &own)), ["h", "a", "c"]);
        assert_eq!(
            labels(&with_own(letters(), 'b', &own)),
            ["h", "a", "c", "b"]
        );
        assert_eq!(labels(&with_own(letters(), '-', &own)), ["h", "a", "c"]);
    }

    #[test]
    fn puts_the_back_hint_before_the_colon_or_after_the_prompt() {
        assert_eq!(back_prompt("Dias: ", "Esc"), "Dias · Esc: ");
        assert_eq!(back_prompt("Dias:", "Esc"), "Dias · Esc:");
        assert_eq!(back_prompt("Nome ", "Esc"), "Nome (Esc) ");
    }

    #[test]
    fn describes_own_without_its_closures() {
        let own = Own {
            same: &PartialEq::eq,
            item: &own_at_end,
        };

        assert_eq!(format!("{own:?}"), "Own { .. }");
    }

    #[test]
    fn matches_the_options_with_the_comparison_given() {
        let own = Own {
            same: &|left: &char, right: &char| left.eq_ignore_ascii_case(right),
            item: &own_at_end,
        };

        assert_eq!(labels(&with_own(letters(), 'C', &own)), ["h", "a", "c"]);
        assert_eq!(
            labels(&with_own(letters(), 'B', &own)),
            ["h", "a", "c", "B"]
        );
    }
}
