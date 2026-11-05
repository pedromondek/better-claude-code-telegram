mod ask;
mod console;
mod fake;
mod guard;
mod hidden;
mod line;
mod piped;
mod select;
mod terminal;

use std::fmt;
use std::io::{self, IsTerminal};

use crate::messages::Messages;
use crate::ui::should_colorize;

pub use ask::{
    ChoiceItem, ChoiceQuestion, Other, ask_choice, ask_hidden, ask_validated, ask_yes_no,
    index_of_value, marked, number_choices,
};
pub use console::{Console, Input, StdConsole};
pub use fake::{FakeCall, FakePrompter, Reply};
pub use guard::GuardCancel;
pub use hidden::{Hidden, HiddenKey};
pub use line::{LineEditor, LineKey, display_width, strip_vt_control_characters};
pub use piped::{LineReader, PipedPrompter};
pub use select::{HIDE_CURSOR, SHOW_CURSOR, Select, SelectKey, render_choices};
pub use terminal::TerminalPrompter;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Choice {
    pub label: String,
    pub hint: Option<String>,
    pub heading: bool,
    pub previous: bool,
}

impl Choice {
    #[must_use]
    pub fn new(label: &str) -> Self {
        Self {
            label: label.to_owned(),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn heading(label: &str) -> Self {
        Self {
            heading: true,
            ..Self::new(label)
        }
    }

    #[must_use]
    pub fn shown_hint(&self) -> Option<&str> {
        self.hint.as_deref().filter(|hint| !hint.is_empty())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Colors {
    pub out: bool,
    pub err: bool,
}

impl Colors {
    #[must_use]
    pub fn of_process(var: &dyn Fn(&str) -> Option<std::ffi::OsString>) -> Self {
        Self {
            out: should_colorize(var, io::stdout().is_terminal()),
            err: should_colorize(var, io::stderr().is_terminal()),
        }
    }
}

#[derive(Debug)]
pub enum PromptError {
    Cancelled(&'static str),
    Ended(&'static str),
    Aborted(&'static str),
    Interrupted(&'static str),
    Io(io::Error),
}

pub const CTRL_D_ABORT: &str = "Aborted with Ctrl+D";

impl PromptError {
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled(_))
    }

    #[must_use]
    pub fn is_interrupted(&self) -> bool {
        matches!(self, Self::Interrupted(_))
    }
}

impl fmt::Display for PromptError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled(message)
            | Self::Ended(message)
            | Self::Aborted(message)
            | Self::Interrupted(message) => formatter.write_str(message),
            Self::Io(error) => error.fmt(formatter),
        }
    }
}

impl From<io::Error> for PromptError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub type Answer<T> = Result<T, PromptError>;

pub trait Prompter {
    fn interactive(&self) -> bool;

    fn colors(&self) -> Colors;

    fn line(&mut self, prompt: &str, messages: &'static Messages) -> Answer<String>;

    fn hidden(&mut self, prompt: &str, messages: &'static Messages) -> Answer<String>;

    fn select(
        &mut self,
        title: &str,
        choices: &[Choice],
        index: usize,
        messages: &'static Messages,
    ) -> Answer<usize>;

    fn report(&mut self, line: &str) -> io::Result<()>;

    fn close(&mut self) {}
}

#[must_use]
pub fn create_prompter(var: &dyn Fn(&str) -> Option<std::ffi::OsString>) -> Box<dyn Prompter> {
    let colors = Colors::of_process(var);

    if io::stdin().is_terminal() {
        let dumb = var("TERM").is_some_and(|term| term == "dumb");

        return Box::new(TerminalPrompter::new(StdConsole::new(), colors, dumb));
    }

    Box::new(PipedPrompter::new(
        io::stdin().lock(),
        io::stdout(),
        io::stderr(),
        colors,
    ))
}
