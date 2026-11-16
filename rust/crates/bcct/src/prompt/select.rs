use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use super::Choice;
use crate::spinner::cut;
use crate::ui::{bold, cyan_bold, frame, green, note};

pub const HIDE_CURSOR: &str = "\u{1b}[?25l";
pub const SHOW_CURSOR: &str = "\u{1b}[?25h";

const POINTER: &str = "❯";
const GAP: usize = 2;

fn max_width(columns: Option<u16>) -> i64 {
    columns
        .filter(|columns| *columns > 0)
        .map_or(i64::MAX, |columns| i64::from(columns) - 1)
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn padded(label: &str, width: usize) -> String {
    let missing = width.saturating_sub(units(label).len());

    format!("{label}{}", " ".repeat(missing))
}

fn choice_line(choice: &Choice, chosen: bool, width: usize, max: i64, colorize: bool) -> String {
    let hint = choice.shown_hint();
    let label = if hint.is_some() {
        padded(&choice.label, width)
    } else {
        choice.label.clone()
    };
    let head = format!("{} {label}", if chosen { POINTER } else { " " });
    let full = hint.map_or_else(|| head.clone(), |hint| format!("{head}  {hint}"));
    let line = units(&cut(&full, max));
    let split = units(&head).len().min(line.len());
    let (shown, tail) = line.split_at(split);
    let shown = String::from_utf16_lossy(shown);
    let styled = if chosen {
        cyan_bold(&shown, colorize)
    } else if choice.previous {
        green(&shown, colorize)
    } else {
        shown
    };

    if tail.is_empty() {
        return styled;
    }

    let rest = String::from_utf16_lossy(tail.get(GAP.min(tail.len())..).unwrap_or_default());

    format!("{styled}  {}", note(&rest, colorize))
}

#[must_use]
pub fn render_choices(
    choices: &[Choice],
    index: usize,
    hint: &str,
    columns: Option<u16>,
    colorize: bool,
) -> Vec<String> {
    let max = max_width(columns);
    let width = choices
        .iter()
        .filter(|choice| !choice.heading)
        .map(|choice| units(&choice.label).len())
        .max()
        .unwrap_or_default();
    let mut lines: Vec<String> = choices
        .iter()
        .enumerate()
        .map(|(position, choice)| {
            if choice.heading {
                bold(&cut(&choice.label, max), colorize)
            } else {
                choice_line(choice, position == index, width, max, colorize)
            }
        })
        .collect();

    lines.push(note(&cut(hint, max), colorize));
    lines
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectKey {
    Ignored,
    Moved,
    Confirmed(usize),
    Cancelled,
    Back,
}

#[derive(Debug)]
pub struct Select<'a> {
    choices: &'a [Choice],
    hint: &'a str,
    colorize: bool,
    current: usize,
    rows: usize,
}

fn is_ctrl_c(key: &KeyEvent) -> bool {
    key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('c' | 'C'))
}

impl<'a> Select<'a> {
    #[must_use]
    pub fn new(choices: &'a [Choice], index: usize, hint: &'a str, colorize: bool) -> Self {
        Self {
            choices,
            hint,
            colorize,
            current: index,
            rows: 0,
        }
    }

    #[must_use]
    pub fn start(&mut self, title: &str, columns: Option<u16>) -> String {
        format!("{HIDE_CURSOR}{title}\n{}", self.draw(columns))
    }

    fn clear(&self) -> String {
        if self.rows > 0 {
            format!("\u{1b}[{}A\r\u{1b}[0J", self.rows)
        } else {
            String::new()
        }
    }

    pub fn draw(&mut self, columns: Option<u16>) -> String {
        let lines = render_choices(
            self.choices,
            self.current,
            self.hint,
            columns,
            self.colorize,
        );
        let text = format!("{}{}\n", self.clear(), lines.join("\n"));

        self.rows = lines.len();
        text
    }

    fn step(&mut self, forward: bool) -> bool {
        let count = self.choices.len();

        for _ in 0..count {
            self.current = if forward {
                (self.current + 1) % count
            } else {
                (self.current + count - 1) % count
            };

            if !self
                .choices
                .get(self.current)
                .is_some_and(|choice| choice.heading)
            {
                return true;
            }
        }

        false
    }

    pub fn key(&mut self, key: &KeyEvent) -> SelectKey {
        if is_ctrl_c(key) {
            return SelectKey::Cancelled;
        }

        let moved = match key.code {
            KeyCode::Up | KeyCode::Char('k' | 'K') => self.step(false),
            KeyCode::Down | KeyCode::Char('j' | 'J') => self.step(true),
            KeyCode::Enter | KeyCode::Right if self.current < self.choices.len() => {
                return SelectKey::Confirmed(self.current);
            }
            KeyCode::Esc | KeyCode::Left => return SelectKey::Back,
            _ => false,
        };

        if moved {
            SelectKey::Moved
        } else {
            SelectKey::Ignored
        }
    }

    #[must_use]
    pub fn confirmation(&self, index: usize) -> String {
        let label = self
            .choices
            .get(index)
            .map(|choice| choice.label.as_str())
            .unwrap_or_default();

        format!(
            "{}{}\n",
            self.clear(),
            frame(&format!("{POINTER} {label}"), self.colorize)
        )
    }
}
