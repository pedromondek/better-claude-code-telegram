use std::io::{self, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::Duration;

use crate::ui::{frame, note};

pub const SPINNER_FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
pub const SPINNER_INTERVAL: Duration = Duration::from_millis(80);
pub const SPINNER_STOP_TIMEOUT: Duration = Duration::from_millis(1000);
pub const WIDE_FROM: u32 = 0x1f000;

const SPINNER_COLUMNS: i64 = 3;
const CLEAR_LINE: &str = "\r\u{1b}[2K";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Terminal {
    pub columns: Option<u16>,
}

#[must_use]
pub fn char_width(character: char) -> i64 {
    if u32::from(character) >= WIDE_FROM {
        2
    } else {
        1
    }
}

#[must_use]
pub fn width_of(text: &str) -> i64 {
    text.chars().map(char_width).sum()
}

#[must_use]
pub fn cut(text: &str, max: i64) -> String {
    if width_of(text) <= max {
        return text.to_owned();
    }

    let mut kept = String::new();
    let mut width = 0;

    for character in text.chars() {
        if width + char_width(character) > max - 1 {
            break;
        }

        kept.push(character);
        width += char_width(character);
    }

    format!("{kept}…")
}

#[derive(Debug)]
pub struct Spinner {
    stop: Sender<()>,
    stopped: Receiver<()>,
}

impl Spinner {
    #[must_use]
    pub fn start<W: Write + Send + 'static>(
        mut writer: W,
        frames: Vec<String>,
        label: String,
        interval: Duration,
    ) -> Option<Self> {
        let (stop, stop_signal) = mpsc::channel::<()>();
        let (stopped_signal, stopped) = mpsc::channel();

        thread::Builder::new()
            .spawn(move || {
                let mut turning = frames.iter().cycle().skip(1);

                while let Err(RecvTimeoutError::Timeout) = stop_signal.recv_timeout(interval) {
                    let shown = turning.next().map(String::as_str).unwrap_or_default();
                    let _written = writer
                        .write_all(format!("\r{shown}{label}").as_bytes())
                        .and_then(|()| writer.flush());
                }

                drop(writer);
                let _sent = stopped_signal.send(());
            })
            .ok()?;

        Some(Self { stop, stopped })
    }

    pub fn stop(self, timeout: Duration) {
        let _sent = self.stop.send(());
        let _stopped = self.stopped.recv_timeout(timeout);
    }
}

#[derive(Debug)]
pub struct Pending {
    live: bool,
    spinner: Option<Spinner>,
    shown: io::Result<()>,
}

impl Pending {
    #[must_use]
    pub fn refused(&self) -> bool {
        self.shown.is_err()
    }

    pub fn finish(self, line: Option<&str>, out: &mut dyn Write) -> io::Result<()> {
        let clears = self.live;
        let shown = self.abandon();

        let mut text = String::new();

        if clears {
            text.push_str(CLEAR_LINE);
        }

        if let Some(line) = line {
            text.push_str(line);
            text.push('\n');
        }

        let written = out.write_all(text.as_bytes()).and_then(|()| out.flush());

        shown.and(written)
    }

    pub fn abandon(self) -> io::Result<()> {
        if let Some(spinner) = self.spinner {
            spinner.stop(SPINNER_STOP_TIMEOUT);
        }

        self.shown
    }
}

pub fn pending(
    text: &str,
    out: &mut dyn Write,
    terminal: Option<Terminal>,
    colorize: bool,
    spin: &dyn Fn(Vec<String>, String) -> Option<Spinner>,
) -> Pending {
    let Some(terminal) = terminal else {
        return Pending {
            live: false,
            spinner: None,
            shown: Ok(()),
        };
    };
    let frames: Vec<String> = SPINNER_FRAMES
        .iter()
        .map(|shown| frame(shown, colorize))
        .collect();
    let max = terminal
        .columns
        .filter(|columns| *columns > 0)
        .map_or(i64::MAX, |columns| i64::from(columns) - SPINNER_COLUMNS);
    let label = format!(" {}", note(&cut(text, max), colorize));
    let first = frames.first().map(String::as_str).unwrap_or_default();
    let shown = out
        .write_all(format!("{first}{label}").as_bytes())
        .and_then(|()| out.flush());

    Pending {
        live: true,
        spinner: spin(frames, label),
        shown,
    }
}

#[must_use]
pub fn spin_on_stdout(frames: Vec<String>, label: String) -> Option<Spinner> {
    Spinner::start(io::stdout(), frames, label, SPINNER_INTERVAL)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    #[derive(Clone, Default)]
    struct Shared(Arc<Mutex<Vec<u8>>>);

    impl Shared {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    impl Write for Shared {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn frames() -> Vec<String> {
        SPINNER_FRAMES
            .iter()
            .map(|shown| (*shown).to_owned())
            .collect()
    }

    fn wait_until(reached: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);

        while !reached() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn cuts_to_the_width_counting_wide_characters_as_two() {
        assert_eq!(cut("Checking the installed plugins…", 9), "Checking…");
        assert_eq!(cut("Checking…", 9), "Checking…");
        assert_eq!(cut("ab", 2), "ab");
        assert_eq!(cut("abc", 2), "a…");
        assert_eq!(cut("abc", 1), "…");
        assert_eq!(cut("abc", -2), "…");
        assert_eq!(cut("😀😀x", 4), "😀…");
        assert_eq!(cut("a😀x", 3), "a…");
        assert_eq!(cut("😀", 2), "😀");
        assert_eq!(char_width('\u{1efff}'), 1);
        assert_eq!(char_width('\u{1f000}'), 2);
        assert_eq!(width_of("a😀"), 3);
    }

    #[test]
    fn the_spinner_turns_in_order_while_the_caller_blocks_and_stops_before_returning() {
        let screen = Shared::default();
        let spinner = Spinner::start(
            screen.clone(),
            frames(),
            " x".to_owned(),
            Duration::from_millis(5),
        )
        .unwrap();

        wait_until(|| screen.text().matches('\r').count() > 11);
        spinner.stop(SPINNER_STOP_TIMEOUT);
        let written = screen.text();
        thread::sleep(Duration::from_millis(60));

        assert_eq!(screen.text(), written);
        assert!(written.starts_with("\r⠙ x\r⠹ x\r⠸ x\r⠼ x\r⠴ x\r⠦ x\r⠧ x\r⠇ x\r⠏ x\r⠋ x\r⠙ x"));
    }

    #[test]
    fn a_spinner_stopped_before_its_first_turn_writes_nothing() {
        let screen = Shared::default();
        let spinner = Spinner::start(
            screen.clone(),
            frames(),
            " x".to_owned(),
            Duration::from_secs(60),
        )
        .unwrap();

        spinner.stop(SPINNER_STOP_TIMEOUT);
        thread::sleep(SPINNER_INTERVAL * 2);

        assert_eq!(screen.text(), "");
    }

    #[test]
    fn a_dropped_spinner_ends_its_thread() {
        let screen = Shared::default();
        let spinner = Spinner::start(
            screen.clone(),
            frames(),
            " x".to_owned(),
            Duration::from_millis(5),
        )
        .unwrap();
        let stopped = Arc::clone(&screen.0);

        drop(spinner);
        thread::sleep(Duration::from_millis(40));

        assert!(Arc::strong_count(&stopped) <= 2);
    }

    struct Slow {
        started: Arc<AtomicBool>,
        _held: Arc<()>,
    }

    impl Write for Slow {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.started.store(true, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(50));
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn finishing_waits_until_the_spinner_lets_go_of_the_terminal() {
        let started = Arc::new(AtomicBool::new(false));
        let held = Arc::new(());
        let mut out = Vec::new();

        let waiting = pending(
            "x",
            &mut out,
            Some(Terminal { columns: None }),
            false,
            &|frames, label| {
                let writer = Slow {
                    started: Arc::clone(&started),
                    _held: Arc::clone(&held),
                };
                Spinner::start(writer, frames, label, Duration::from_millis(1))
            },
        );
        wait_until(|| started.load(Ordering::SeqCst));
        waiting.finish(Some("done"), &mut out).unwrap();

        assert_eq!(Arc::strong_count(&held), 1);
    }

    #[test]
    fn a_stuck_spinner_is_waited_for_only_until_the_timeout() {
        let (stop, _signal) = mpsc::channel();
        let (_never, stopped) = mpsc::channel();
        let spinner = Spinner { stop, stopped };
        let started = Instant::now();

        spinner.stop(Duration::from_millis(30));

        assert!(started.elapsed() >= Duration::from_millis(30));
    }

    #[test]
    fn on_a_terminal_it_shows_the_first_frame_and_replaces_the_line_with_the_result() {
        let mut out = Vec::new();
        let terminal = Some(Terminal { columns: Some(80) });

        let waiting = pending("Installing…", &mut out, terminal, false, &|_, _| None);
        assert_eq!(String::from_utf8(out.clone()).unwrap(), "⠋ Installing…");

        waiting.finish(Some("✔ Installed."), &mut out).unwrap();
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "⠋ Installing…\r\u{1b}[2K✔ Installed.\n"
        );
    }

    #[test]
    fn without_a_result_it_only_clears_the_line() {
        let mut out = Vec::new();
        let terminal = Some(Terminal { columns: None });

        pending("Checking…", &mut out, terminal, false, &|_, _| None)
            .finish(None, &mut out)
            .unwrap();

        assert_eq!(String::from_utf8(out).unwrap(), "⠋ Checking…\r\u{1b}[2K");
    }

    #[test]
    fn the_label_is_cut_so_the_line_never_wraps_and_painted_on_request() {
        let mut out = Vec::new();

        pending(
            "Checking the installed plugins…",
            &mut out,
            Some(Terminal { columns: Some(12) }),
            true,
            &|_, _| None,
        );

        assert_eq!(
            String::from_utf8(out).unwrap(),
            "\u{1b}[36m⠋\u{1b}[39m \u{1b}[2mChecking…\u{1b}[22m"
        );
    }

    #[test]
    fn a_zero_width_terminal_does_not_cut() {
        let mut out = Vec::new();

        pending(
            "Checking the installed plugins…",
            &mut out,
            Some(Terminal { columns: Some(0) }),
            false,
            &|_, _| None,
        );

        assert_eq!(
            String::from_utf8(out).unwrap(),
            "⠋ Checking the installed plugins…"
        );
    }

    #[test]
    fn the_spinner_gets_the_painted_frames_and_label() {
        let mut out = Vec::new();
        let seen = Mutex::new(None);

        let waiting = pending(
            "Checking…",
            &mut out,
            Some(Terminal { columns: None }),
            false,
            &|frames, label| {
                *seen.lock().unwrap() = Some((frames, label));
                Spinner::start(io::sink(), Vec::new(), String::new(), SPINNER_INTERVAL)
            },
        );
        waiting.finish(Some("done"), &mut out).unwrap();

        assert_eq!(
            seen.lock().unwrap().clone(),
            Some((frames(), " Checking…".to_owned()))
        );
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "⠋ Checking…\r\u{1b}[2Kdone\n"
        );
    }

    #[test]
    fn outside_a_terminal_only_the_result_is_written() {
        let mut out = Vec::new();

        pending("Installing…", &mut out, None, true, &|_, _| None)
            .finish(Some("✔ Installed."), &mut out)
            .unwrap();

        assert_eq!(String::from_utf8(out).unwrap(), "✔ Installed.\n");
    }

    #[test]
    fn the_stdout_spinner_starts_and_stops() {
        spin_on_stdout(Vec::new(), String::new())
            .unwrap()
            .stop(SPINNER_STOP_TIMEOUT);
    }
}
