use std::collections::VecDeque;
use std::io::{self, BufRead, Write};

use super::{Answer, Choice, Colors, PromptError, Prompter};
use crate::js::js_trim;
use crate::messages::Messages;

const SEPARATORS: [char; 2] = ['\u{2028}', '\u{2029}'];

#[derive(Debug)]
pub struct LineReader<R: BufRead> {
    input: R,
    pending: VecDeque<String>,
    after_return: bool,
    ended: bool,
}

impl<R: BufRead> LineReader<R> {
    pub fn new(input: R) -> Self {
        Self {
            input,
            pending: VecDeque::new(),
            after_return: false,
            ended: false,
        }
    }

    fn queue(&mut self, bytes: &[u8], terminated: bool) {
        let text = String::from_utf8_lossy(bytes);
        let mut pieces: Vec<String> = text.split(SEPARATORS).map(str::to_owned).collect();

        if !terminated && pieces.last().is_some_and(String::is_empty) {
            pieces.pop();
        }

        self.pending.extend(pieces);
    }

    fn read_raw_line(&mut self) -> io::Result<Option<Vec<u8>>> {
        let mut line = Vec::new();

        loop {
            let buffer = self.input.fill_buf()?;

            let Some(first) = buffer.first().copied() else {
                self.ended = true;
                return Ok((!line.is_empty()).then_some(line));
            };

            if self.after_return {
                self.after_return = false;

                if first == b'\n' {
                    self.input.consume(1);
                    continue;
                }
            }

            let end = buffer.iter().position(|byte| matches!(byte, b'\n' | b'\r'));
            let taken = end.unwrap_or(buffer.len());

            line.extend_from_slice(buffer.get(..taken).unwrap_or_default());

            if let Some(end) = end {
                self.after_return = buffer.get(end) == Some(&b'\r');
                self.input.consume(end + 1);
                return Ok(Some(line));
            }

            self.input.consume(taken);
        }
    }

    pub fn next_line(&mut self) -> io::Result<Option<String>> {
        loop {
            if let Some(line) = self.pending.pop_front() {
                return Ok(Some(line));
            }

            if self.ended {
                return Ok(None);
            }

            match self.read_raw_line()? {
                Some(bytes) => {
                    let terminated = !self.ended;

                    self.queue(&bytes, terminated);
                }
                None => return Ok(None),
            }
        }
    }
}

#[derive(Debug)]
pub struct PipedPrompter<R: BufRead, W: Write, E: Write> {
    lines: LineReader<R>,
    out: W,
    err: E,
    colors: Colors,
}

impl<R: BufRead, W: Write, E: Write> PipedPrompter<R, W, E> {
    pub fn new(input: R, out: W, err: E, colors: Colors) -> Self {
        Self {
            lines: LineReader::new(input),
            out,
            err,
            colors,
        }
    }

    pub fn into_parts(self) -> (W, E) {
        (self.out, self.err)
    }

    fn write(&mut self, text: &str) -> io::Result<()> {
        self.out.write_all(text.as_bytes())?;
        self.out.flush()
    }
}

impl<R: BufRead, W: Write, E: Write> Prompter for PipedPrompter<R, W, E> {
    fn interactive(&self) -> bool {
        false
    }

    fn colors(&self) -> Colors {
        self.colors
    }

    fn line(&mut self, prompt: &str, messages: &'static Messages) -> Answer<String> {
        self.write(prompt)?;

        self.lines
            .next_line()?
            .ok_or(PromptError::Ended(messages.cancelled))
    }

    fn hidden(&mut self, prompt: &str, messages: &'static Messages) -> Answer<String> {
        let answer = self.line(prompt, messages)?;

        self.write("\n")?;
        Ok(js_trim(&answer).to_owned())
    }

    fn select(
        &mut self,
        _title: &str,
        _choices: &[Choice],
        _index: usize,
        _messages: &'static Messages,
    ) -> Answer<usize> {
        Err(PromptError::Io(io::Error::from(io::ErrorKind::Unsupported)))
    }

    fn report(&mut self, line: &str) -> io::Result<()> {
        self.err.write_all(format!("{line}\n").as_bytes())?;
        self.err.flush()
    }
}
