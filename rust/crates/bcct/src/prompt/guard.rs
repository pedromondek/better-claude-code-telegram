use std::io;

use super::{Answer, Choice, Colors, PromptError, Prompter};
use crate::messages::Messages;
use crate::ui::question;

const LEAVE: usize = 1;

pub struct GuardCancel<'a> {
    inner: &'a mut dyn Prompter,
}

impl std::fmt::Debug for GuardCancel<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GuardCancel")
            .field("interactive", &self.inner.interactive())
            .finish()
    }
}

impl<'a> GuardCancel<'a> {
    pub fn new(inner: &'a mut dyn Prompter) -> Self {
        Self { inner }
    }

    fn leaving(&mut self, messages: &'static Messages) -> bool {
        let choices = [
            Choice::new(messages.continue_setup),
            Choice::new(messages.exit_setup),
        ];
        let title = question(messages.exit_prompt, self.inner.colors().out);

        self.inner
            .select(&title, &choices, LEAVE, messages)
            .map_or(true, |chosen| chosen == LEAVE)
    }

    fn retrying<T>(
        &mut self,
        messages: &'static Messages,
        mut ask: impl FnMut(&mut dyn Prompter) -> Answer<T>,
    ) -> Answer<T> {
        if !self.inner.interactive() {
            return ask(&mut *self.inner);
        }

        loop {
            match ask(&mut *self.inner) {
                Err(PromptError::Cancelled(_)) => {
                    if self.leaving(messages) {
                        return Err(PromptError::Interrupted(messages.interrupted));
                    }
                }
                other => return other,
            }
        }
    }
}

impl Prompter for GuardCancel<'_> {
    fn interactive(&self) -> bool {
        self.inner.interactive()
    }

    fn colors(&self) -> Colors {
        self.inner.colors()
    }

    fn line(&mut self, prompt: &str, messages: &'static Messages) -> Answer<String> {
        self.retrying(messages, |inner| inner.line(prompt, messages))
    }

    fn hidden(&mut self, prompt: &str, messages: &'static Messages) -> Answer<String> {
        self.retrying(messages, |inner| inner.hidden(prompt, messages))
    }

    fn select(
        &mut self,
        title: &str,
        choices: &[Choice],
        index: usize,
        messages: &'static Messages,
    ) -> Answer<usize> {
        self.retrying(messages, |inner| {
            inner.select(title, choices, index, messages)
        })
    }

    fn report(&mut self, line: &str) -> io::Result<()> {
        self.inner.report(line)
    }

    fn close(&mut self) {
        self.inner.close();
    }
}
