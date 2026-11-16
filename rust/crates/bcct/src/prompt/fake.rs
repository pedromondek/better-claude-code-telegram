use std::collections::VecDeque;
use std::io;

use super::{Answer, Choice, Colors, PromptError, Prompter};
use crate::messages::Messages;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FakeCall {
    Line {
        prompt: String,
    },
    Hidden {
        prompt: String,
    },
    Select {
        title: String,
        choices: Vec<Choice>,
        index: usize,
    },
}

impl FakeCall {
    #[must_use]
    pub fn select(&self) -> Option<(&[Choice], usize)> {
        match self {
            Self::Select { choices, index, .. } => Some((choices, *index)),
            Self::Line { .. } | Self::Hidden { .. } => None,
        }
    }

    #[must_use]
    pub fn line(&self) -> Option<&str> {
        match self {
            Self::Line { prompt } => Some(prompt),
            Self::Hidden { .. } | Self::Select { .. } => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    Text(String),
    Choose(usize),
    Default,
    Last,
    Cancel,
    End,
    Back,
    Fail(io::ErrorKind),
}

#[derive(Debug, Default)]
pub struct FakePrompter {
    interactive: bool,
    colors: Colors,
    back: bool,
    replies: VecDeque<Reply>,
    calls: Vec<FakeCall>,
    reports: Vec<String>,
    closed: bool,
}

fn failure(reply: &Reply, back: bool, messages: &'static Messages) -> PromptError {
    match reply {
        Reply::Back => {
            assert!(back, "Reply::Back while going back is off");
            PromptError::Back
        }
        Reply::Cancel => PromptError::Cancelled(messages.cancelled),
        Reply::End => PromptError::Ended(messages.cancelled),
        Reply::Fail(kind) => PromptError::Io(io::Error::from(*kind)),
        _ => PromptError::Io(io::Error::from(io::ErrorKind::InvalidInput)),
    }
}

impl FakePrompter {
    #[must_use]
    pub fn new(interactive: bool) -> Self {
        Self {
            interactive,
            ..Self::default()
        }
    }

    #[must_use]
    pub fn with_colors(mut self, colors: Colors) -> Self {
        self.colors = colors;
        self
    }

    #[must_use]
    pub fn with_replies(mut self, replies: impl IntoIterator<Item = Reply>) -> Self {
        self.replies.extend(replies);
        self
    }

    pub fn push_reply(&mut self, reply: Reply) {
        self.replies.push_back(reply);
    }

    #[must_use]
    pub fn calls(&self) -> &[FakeCall] {
        &self.calls
    }

    #[must_use]
    pub fn reports(&self) -> &[String] {
        &self.reports
    }

    #[must_use]
    pub fn closed(&self) -> bool {
        self.closed
    }

    fn typed(&mut self, messages: &'static Messages) -> Answer<String> {
        match self.replies.pop_front() {
            None => Ok(String::new()),
            Some(Reply::Text(text)) => Ok(text),
            Some(other) => Err(failure(&other, self.back, messages)),
        }
    }
}

impl Prompter for FakePrompter {
    fn interactive(&self) -> bool {
        self.interactive
    }

    fn colors(&self) -> Colors {
        self.colors
    }

    fn back(&self) -> bool {
        self.back
    }

    fn set_back(&mut self, allowed: bool) {
        self.back = allowed;
    }

    fn line(&mut self, prompt: &str, messages: &'static Messages) -> Answer<String> {
        self.calls.push(FakeCall::Line {
            prompt: prompt.to_owned(),
        });
        self.typed(messages)
    }

    fn hidden(&mut self, prompt: &str, messages: &'static Messages) -> Answer<String> {
        self.calls.push(FakeCall::Hidden {
            prompt: prompt.to_owned(),
        });
        self.typed(messages)
    }

    fn select(
        &mut self,
        title: &str,
        choices: &[Choice],
        index: usize,
        messages: &'static Messages,
    ) -> Answer<usize> {
        self.calls.push(FakeCall::Select {
            title: title.to_owned(),
            choices: choices.to_vec(),
            index,
        });

        match self.replies.pop_front() {
            None | Some(Reply::Default) => Ok(index),
            Some(Reply::Choose(chosen)) => Ok(chosen),
            Some(Reply::Last) => Ok(choices.len().saturating_sub(1)),
            Some(other) => Err(failure(&other, self.back, messages)),
        }
    }

    fn report(&mut self, line: &str) -> io::Result<()> {
        self.reports.push(line.to_owned());
        Ok(())
    }

    fn close(&mut self) {
        self.closed = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_choices_of_a_select_and_the_prompt_of_a_line() {
        let select = FakeCall::Select {
            title: "T".to_owned(),
            choices: vec![Choice::new("a")],
            index: 0,
        };
        let line = FakeCall::Line {
            prompt: "Q? ".to_owned(),
        };
        let hidden = FakeCall::Hidden {
            prompt: "T: ".to_owned(),
        };

        assert_eq!(select.select(), Some((&[Choice::new("a")][..], 0)));
        assert_eq!(select.line(), None);
        assert_eq!(line.line(), Some("Q? "));
        assert_eq!(line.select(), None);
        assert_eq!(hidden.select(), None);
        assert_eq!(hidden.line(), None);
    }
}
