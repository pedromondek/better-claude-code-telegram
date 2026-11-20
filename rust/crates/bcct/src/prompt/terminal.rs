use std::io;

use super::console::{Console, Input};
use super::hidden::{Hidden, HiddenKey};
use super::line::{LineEditor, LineKey};
use super::select::{SHOW_CURSOR, Select, SelectKey};
use super::{Answer, Choice, Colors, PromptError, Prompter};
use crate::messages::Messages;

#[derive(Debug)]
pub struct TerminalPrompter<C: Console> {
    console: C,
    colors: Colors,
    dumb: bool,
    back: bool,
}

impl<C: Console> TerminalPrompter<C> {
    pub fn new(console: C, colors: Colors, dumb: bool) -> Self {
        Self {
            console,
            colors,
            dumb,
            back: false,
        }
    }

    pub fn console(&self) -> &C {
        &self.console
    }

    fn release(&mut self) -> io::Result<()> {
        self.console.discard_pending()?;
        self.console.set_raw(false)
    }

    fn released<T>(&mut self, answer: Answer<T>) -> Answer<T> {
        if matches!(answer, Err(PromptError::Io(_))) {
            let _released = self.release();
        }

        answer
    }

    fn edit_line(&mut self, prompt: &str, messages: &'static Messages) -> Answer<String> {
        let mut editor = LineEditor::new(prompt);

        editor.set_columns(self.console.columns());
        self.console.write(&editor.start(self.dumb))?;

        loop {
            let input = self.console.read_input()?;

            editor.set_columns(self.console.columns());

            let (out, state) = match input {
                Input::Key(key) => editor.key(&key),
                Input::Resized => (editor.refresh(), LineKey::Editing),
            };

            self.console.write(&out)?;

            match state {
                LineKey::Suspended => {
                    self.console.set_raw(false)?;
                    self.console.suspend()?;
                    self.console.set_raw(true)?;
                    editor.set_columns(self.console.columns());

                    let drawn = editor.refresh();

                    self.console.write(&drawn)?;
                }
                LineKey::Line(line) => {
                    self.release()?;
                    return Ok(line);
                }
                LineKey::Cancelled => {
                    self.release()?;
                    return Err(PromptError::Cancelled(messages.cancelled));
                }
                LineKey::Aborted => {
                    self.release()?;
                    return Err(PromptError::Aborted(messages.aborted));
                }
                LineKey::Back if self.back => {
                    self.console.write(&editor.finish_line())?;
                    self.release()?;
                    return Err(PromptError::Back);
                }
                LineKey::Editing | LineKey::Back => {}
            }
        }
    }

    fn read_hidden(&mut self, messages: &'static Messages) -> Answer<String> {
        let mut hidden = Hidden::new();

        loop {
            let chunk = self.console.read_chunk()?;
            let state = if chunk.is_empty() {
                None
            } else {
                Some(hidden.chunk(&chunk))
            };

            if state == Some(HiddenKey::Typing) {
                continue;
            }

            self.console.set_raw(false)?;
            self.console.write("\n")?;

            return match state {
                Some(HiddenKey::Done(typed)) => Ok(typed),
                Some(HiddenKey::Cancelled) => Err(PromptError::Cancelled(messages.cancelled)),
                _ => Err(PromptError::Ended(messages.cancelled)),
            };
        }
    }

    fn choose(
        &mut self,
        title: &str,
        choices: &[Choice],
        index: usize,
        messages: &'static Messages,
    ) -> Answer<usize> {
        let hint = if self.back {
            format!("{} · {}", messages.select_hint, messages.back_hint)
        } else {
            messages.select_hint.to_owned()
        };
        let mut select = Select::new(choices, index, &hint, self.colors.out);

        self.console
            .write(&select.start(title, self.console.columns()))?;
        self.console.set_raw(true)?;

        loop {
            let Input::Key(key) = self.console.read_input()? else {
                continue;
            };

            match select.key(&key) {
                SelectKey::Moved => {
                    let drawn = select.draw(self.console.columns());

                    self.console.write(&drawn)?;
                }
                SelectKey::Confirmed(chosen) => {
                    self.release()?;
                    self.console.write(&select.confirmation(chosen))?;
                    self.console.write(SHOW_CURSOR)?;
                    return Ok(chosen);
                }
                SelectKey::Cancelled => {
                    self.release()?;
                    self.console.write(SHOW_CURSOR)?;
                    return Err(PromptError::Cancelled(messages.cancelled));
                }
                SelectKey::Back if self.back => {
                    self.release()?;
                    self.console.write(SHOW_CURSOR)?;
                    return Err(PromptError::Back);
                }
                SelectKey::Ignored | SelectKey::Back => {}
            }
        }
    }
}

impl<C: Console> Prompter for TerminalPrompter<C> {
    fn interactive(&self) -> bool {
        true
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
        if !self.console.output_is_terminal() {
            self.console.write(prompt)?;

            return self
                .console
                .read_line()?
                .ok_or(PromptError::Ended(messages.cancelled));
        }

        self.console.set_raw(true)?;

        let answer = self.edit_line(prompt, messages);

        self.released(answer)
    }

    fn hidden(&mut self, prompt: &str, messages: &'static Messages) -> Answer<String> {
        self.console.write(prompt)?;
        self.console.set_raw(true)?;

        let answer = self.read_hidden(messages);

        self.released(answer)
    }

    fn select(
        &mut self,
        title: &str,
        choices: &[Choice],
        index: usize,
        messages: &'static Messages,
    ) -> Answer<usize> {
        let answer = self.choose(title, choices, index, messages);

        self.released(answer)
    }

    fn report(&mut self, line: &str) -> io::Result<()> {
        self.console.write_error(&format!("{line}\n"))
    }
}
