use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use crate::telegram::Interruption;

#[derive(Debug)]
pub struct Interrupted {
    pub flag: Arc<AtomicBool>,
    pub interruption: Interruption,
}

#[cfg(unix)]
const SIGNAL_EXIT_BASE: i32 = 128;

#[cfg(unix)]
fn ended_by(
    signal: i32,
    saved: Option<&rustix::termios::Termios>,
    screen: Option<&mut dyn std::io::Write>,
    emulate: &dyn Fn(i32) -> std::io::Result<()>,
) -> i32 {
    use rustix::termios::{OptionalActions, tcsetattr};

    use crate::prompt::SHOW_CURSOR;

    let _restored = saved.map(|saved| tcsetattr(std::io::stdin(), OptionalActions::Now, saved));
    let _shown = screen.map(|screen| {
        screen
            .write_all(SHOW_CURSOR.as_bytes())
            .and_then(|()| screen.flush())
    });
    let _ended = emulate(signal);

    SIGNAL_EXIT_BASE + signal
}

#[cfg(unix)]
pub fn watch(interrupted: Option<Interrupted>) {
    watch_with(interrupted, signal_hook::low_level::emulate_default_handler);
}

#[cfg(unix)]
pub fn watch_with(interrupted: Option<Interrupted>, emulate: fn(i32) -> std::io::Result<()>) {
    use std::io::{self, IsTerminal, Write};
    use std::sync::atomic::Ordering;
    use std::thread;

    use rustix::termios::tcgetattr;
    use signal_hook::consts::{SIGINT, SIGTERM};
    use signal_hook::iterator::Signals;

    let saved = tcgetattr(io::stdin()).ok();
    let _watching = Signals::new([SIGINT, SIGTERM]).map(|mut signals| {
        thread::Builder::new().spawn(move || {
            for signal in signals.forever() {
                match &interrupted {
                    Some(interrupted) if signal == SIGINT => {
                        interrupted.flag.store(true, Ordering::SeqCst);
                        interrupted.interruption.interrupt();
                    }
                    _ => {
                        let mut out = io::stdout();
                        let on_terminal = out.is_terminal();
                        let screen = on_terminal.then_some(&mut out as &mut dyn Write);

                        std::process::exit(ended_by(signal, saved.as_ref(), screen, &emulate));
                    }
                }
            }
        })
    });
}

#[cfg(not(unix))]
pub fn watch(_interrupted: Option<Interrupted>) {}

#[cfg(all(test, unix))]
mod tests {
    use std::cell::RefCell;
    use std::io::{self, Write};
    use std::rc::Rc;

    use super::*;
    use crate::prompt::SHOW_CURSOR;

    #[derive(Clone, Default)]
    struct Shared(Rc<RefCell<Vec<u8>>>);

    impl Write for Shared {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.borrow_mut().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn the_cursor_comes_back_before_dying_and_the_exit_code_only_counts_if_it_survives() {
        let written = Shared::default();
        let mut screen = written.clone();
        let seen = RefCell::new(Vec::new());
        let emulate = |signal: i32| {
            seen.borrow_mut().push((signal, written.0.borrow().clone()));
            Ok(())
        };

        assert_eq!(ended_by(15, None, Some(&mut screen), &emulate), 143);
        assert_eq!(*seen.borrow(), vec![(15, SHOW_CURSOR.as_bytes().to_vec())]);
    }

    #[test]
    fn an_output_that_is_not_a_terminal_gets_no_cursor_and_a_failed_emulation_still_ends() {
        let emulate = |_: i32| Err(io::ErrorKind::Other.into());

        assert_eq!(ended_by(2, None, None, &emulate), 130);
    }
}
