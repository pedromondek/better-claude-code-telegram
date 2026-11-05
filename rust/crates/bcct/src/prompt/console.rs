use std::io::{self, IsTerminal, Read, Write};
use std::time::Duration;

use crossterm::event::{self, Event, KeyEvent, KeyEventKind};

use super::piped::LineReader;

const CHUNK_SIZE: usize = 65_536;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input {
    Key(KeyEvent),
    Resized,
}

pub trait Console {
    fn set_raw(&mut self, on: bool) -> io::Result<()>;

    fn columns(&self) -> Option<u16>;

    fn output_is_terminal(&self) -> bool;

    fn read_input(&mut self) -> io::Result<Input>;

    fn read_chunk(&mut self) -> io::Result<Vec<u8>>;

    fn read_line(&mut self) -> io::Result<Option<String>>;

    fn discard_pending(&mut self) -> io::Result<()>;

    fn suspend(&mut self) -> io::Result<()>;

    fn write(&mut self, text: &str) -> io::Result<()>;

    fn write_error(&mut self, text: &str) -> io::Result<()>;
}

#[derive(Debug, Default)]
pub struct StdConsole {
    #[cfg(unix)]
    saved: Option<rustix::termios::Termios>,
    size: Option<(u16, u16)>,
    raw: bool,
}

impl Drop for StdConsole {
    fn drop(&mut self) {
        if self.raw {
            let _restored = self.set_raw(false);
        }
    }
}

impl StdConsole {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn window_size() -> Option<(u16, u16)> {
        if !io::stdout().is_terminal() {
            return None;
        }

        #[cfg(unix)]
        let size = rustix::termios::tcgetwinsize(io::stdout())
            .ok()
            .map(|size| (size.ws_col, size.ws_row));
        #[cfg(not(unix))]
        let size = crossterm::terminal::size().ok();

        size
    }

    fn size_changed(&mut self) -> bool {
        let current = Self::window_size();
        let changed = current != self.size;

        self.size = current;
        changed
    }

    #[cfg(unix)]
    fn apply_raw(&mut self, on: bool) -> io::Result<()> {
        use rustix::termios::{
            ControlModes, InputModes, LocalModes, OptionalActions, OutputModes, SpecialCodeIndex,
            tcgetattr, tcsetattr,
        };

        let stdin = io::stdin();
        let current = tcgetattr(&stdin)?;
        let saved = self.saved.get_or_insert_with(|| current.clone()).clone();
        let mode = if on {
            let mut raw = current;

            raw.input_modes.remove(
                InputModes::BRKINT
                    .union(InputModes::ICRNL)
                    .union(InputModes::INPCK)
                    .union(InputModes::ISTRIP)
                    .union(InputModes::IXON),
            );
            raw.output_modes.insert(OutputModes::ONLCR);
            raw.control_modes.insert(ControlModes::CS8);
            raw.local_modes.remove(
                LocalModes::ECHO
                    .union(LocalModes::ICANON)
                    .union(LocalModes::IEXTEN)
                    .union(LocalModes::ISIG),
            );
            raw.special_codes[SpecialCodeIndex::VMIN] = 1;
            raw.special_codes[SpecialCodeIndex::VTIME] = 0;
            raw
        } else {
            saved
        };

        tcsetattr(&stdin, OptionalActions::Drain, &mode)?;
        Ok(())
    }
}

impl Console for StdConsole {
    fn set_raw(&mut self, on: bool) -> io::Result<()> {
        self.size = Self::window_size();

        #[cfg(unix)]
        let applied = self.apply_raw(on);
        #[cfg(not(unix))]
        let applied = if on {
            crossterm::terminal::enable_raw_mode()
        } else {
            crossterm::terminal::disable_raw_mode()
        };

        self.raw = on;

        applied
    }

    fn columns(&self) -> Option<u16> {
        Self::window_size().map(|(columns, _)| columns)
    }

    fn output_is_terminal(&self) -> bool {
        io::stdout().is_terminal()
    }

    fn read_input(&mut self) -> io::Result<Input> {
        loop {
            match event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => return Ok(Input::Key(key)),
                Event::Resize(..) if self.size_changed() => return Ok(Input::Resized),
                _ => {}
            }
        }
    }

    fn read_chunk(&mut self) -> io::Result<Vec<u8>> {
        let mut buffer = vec![0; CHUNK_SIZE];
        let read = io::stdin().read(&mut buffer)?;

        buffer.truncate(read);
        Ok(buffer)
    }

    fn read_line(&mut self) -> io::Result<Option<String>> {
        LineReader::new(io::stdin().lock()).next_line()
    }

    fn discard_pending(&mut self) -> io::Result<()> {
        while event::poll(Duration::ZERO)? {
            event::read()?;
        }

        Ok(())
    }

    fn suspend(&mut self) -> io::Result<()> {
        #[cfg(unix)]
        rustix::process::kill_process(rustix::process::getpid(), rustix::process::Signal::TSTP)?;

        Ok(())
    }

    fn write(&mut self, text: &str) -> io::Result<()> {
        let mut out = io::stdout().lock();

        out.write_all(text.as_bytes())?;
        out.flush()
    }

    fn write_error(&mut self, text: &str) -> io::Result<()> {
        let mut err = io::stderr().lock();

        err.write_all(text.as_bytes())?;
        err.flush()
    }
}
