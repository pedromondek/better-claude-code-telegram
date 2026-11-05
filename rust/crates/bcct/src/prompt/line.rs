use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::js::is_js_whitespace;

const MAX_UNDO: usize = 2048;
const MAX_KILLS: usize = 32;
const FILE_SEPARATOR: char = '\u{1c}';
const GROUP_SEPARATOR: char = '\u{1d}';
const ESCAPE: char = '\u{1b}';
const CONTROL_SEQUENCE: char = '\u{9b}';
const BELL: char = '\u{7}';
const STRING_TERMINATOR: char = '\u{9c}';
const TAB_SIZE: u64 = 8;
const MAX_DIGITS: usize = 4;
const WIDE_FROM: u32 = 0x1f000;

fn is_intermediate(character: char) -> bool {
    matches!(character, '[' | ']' | '(' | ')' | '#' | ';' | '?')
}

fn is_parameter(character: char) -> bool {
    character.is_ascii_alphanumeric()
        || matches!(
            character,
            '-' | '/' | '#' | '&' | '.' | ':' | '=' | '?' | '%' | '@' | '~' | '_'
        )
}

fn is_final(character: char) -> bool {
    character.is_ascii_digit()
        || matches!(character, 'A'..='P' | 'R'..='T' | 'Z' | 'c'..='n' | 'q'..='u' | 'y' | '=' | '>' | '<' | '~')
}

fn count_while(text: &[char], from: usize, accepts: fn(char) -> bool) -> usize {
    text.get(from..)
        .unwrap_or_default()
        .iter()
        .take_while(|character| accepts(**character))
        .count()
}

fn terminator(text: &[char], at: usize) -> Option<usize> {
    match (text.get(at), text.get(at + 1)) {
        (Some(&(BELL | STRING_TERMINATOR)), _) => Some(at + 1),
        (Some(&ESCAPE), Some('\\')) => Some(at + 2),
        _ => None,
    }
}

fn parameter_groups(text: &[char], mut at: usize, each_needs_one: bool) -> usize {
    for _ in 0..text.len() {
        if text.get(at) != Some(&';') {
            break;
        }

        let run = count_while(text, at + 1, is_parameter);

        if each_needs_one && run == 0 {
            break;
        }

        at += 1 + run;
    }

    at
}

fn string_sequence(text: &[char], at: usize) -> Option<usize> {
    terminator(text, parameter_groups(text, at, true)).or_else(|| {
        let run = count_while(text, at, |character| character.is_ascii_alphanumeric());

        (run > 0)
            .then(|| terminator(text, parameter_groups(text, at + run, false)))
            .flatten()
    })
}

fn digit_ends(text: &[char], at: usize, ends: &mut Vec<usize>) {
    if text.get(at) == Some(&';') {
        let digits = count_while(text, at + 1, |character| character.is_ascii_digit());

        for taken in (0..=digits.min(MAX_DIGITS)).rev() {
            digit_ends(text, at + 1 + taken, ends);
        }
    }

    ends.push(at);
}

fn final_sequence(text: &[char], at: usize) -> Option<usize> {
    let digits = count_while(text, at, |character| character.is_ascii_digit());
    let mut ends = Vec::new();

    for taken in (1..=digits.min(MAX_DIGITS)).rev() {
        digit_ends(text, at + taken, &mut ends);
    }

    ends.push(at);
    ends.into_iter().find_map(|end| {
        text.get(end)
            .is_some_and(|character| is_final(*character))
            .then_some(end + 1)
    })
}

fn escape_end(text: &[char], start: usize) -> Option<usize> {
    if !matches!(text.get(start), Some(&(ESCAPE | CONTROL_SEQUENCE))) {
        return None;
    }

    let intermediates = count_while(text, start + 1, is_intermediate);

    (0..=intermediates).rev().find_map(|taken| {
        let at = start + 1 + taken;

        string_sequence(text, at).or_else(|| final_sequence(text, at))
    })
}

#[must_use]
pub fn strip_vt_control_characters(text: &str) -> String {
    let characters: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut skip_to = 0;

    for (at, character) in characters.iter().enumerate() {
        if at < skip_to {
            continue;
        }

        if let Some(end) = escape_end(&characters, at) {
            skip_to = end;
        } else {
            out.push(*character);
        }
    }

    out
}

fn zero_width(code: u32) -> bool {
    code <= 0x1f
        || (0x7f..=0x9f).contains(&code)
        || (0x300..=0x36f).contains(&code)
        || (0x200b..=0x200f).contains(&code)
        || (0x20d0..=0x20ff).contains(&code)
        || (0xfe00..=0xfe0f).contains(&code)
        || (0xfe20..=0xfe2f).contains(&code)
        || (0xe0100..=0xe01ef).contains(&code)
}

fn full_width(code: u32) -> bool {
    code >= WIDE_FROM
        || (0x1100..=0x115f).contains(&code)
        || code == 0x2329
        || code == 0x232a
        || ((0x2e80..=0x3247).contains(&code) && code != 0x303f)
        || (0x3250..=0x4dbf).contains(&code)
        || (0x4e00..=0xa4c6).contains(&code)
        || (0xa960..=0xa97c).contains(&code)
        || (0xac00..=0xd7a3).contains(&code)
        || (0xf900..=0xfaff).contains(&code)
        || (0xfe10..=0xfe19).contains(&code)
        || (0xfe30..=0xfe6b).contains(&code)
        || (0xff01..=0xff60).contains(&code)
        || (0xffe0..=0xffe6).contains(&code)
        || (0x1b000..=0x1b001).contains(&code)
}

#[must_use]
pub fn display_width(character: char) -> u64 {
    let code = u32::from(character);

    if zero_width(code) {
        0
    } else if full_width(code) {
        2
    } else {
        1
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Position {
    cols: u64,
    rows: u64,
}

fn display_position(text: &str, columns: Option<u64>) -> Position {
    let mut offset: u64 = 0;
    let mut rows: u64 = 0;

    for character in strip_vt_control_characters(text).chars() {
        if character == '\n' {
            rows += columns.map_or(0, |columns| offset.div_ceil(columns)).max(1);
            offset = 0;
            continue;
        }

        if character == '\t' {
            offset += TAB_SIZE - offset % TAB_SIZE;
            continue;
        }

        let width = display_width(character);

        if width < 2 {
            offset += width;
        } else {
            if columns.is_some_and(|columns| (offset + 1).is_multiple_of(columns)) {
                offset += 1;
            }

            offset += 2;
        }
    }

    let cols = columns.map_or(offset, |columns| offset % columns);

    Position {
        cols,
        rows: rows + columns.map_or(0, |columns| (offset - cols) / columns),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineKey {
    Editing,
    Line(String),
    Cancelled,
    Aborted,
    Suspended,
}

#[derive(Debug)]
pub struct LineEditor {
    prompt: String,
    line: Vec<char>,
    cursor: usize,
    prev_rows: u64,
    columns: Option<u64>,
    undone: Vec<Snapshot>,
    redone: Vec<Snapshot>,
    kills: Vec<Vec<char>>,
    kill_cursor: usize,
    yanking: bool,
}

#[derive(Debug)]
struct Snapshot {
    line: Vec<char>,
    cursor: usize,
}

fn is_word(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

fn is_not_word(character: char) -> bool {
    !is_word(character)
}

fn is_symbol(character: char) -> bool {
    !is_word(character) && !is_js_whitespace(character)
}

fn run_of(characters: &[char], accepts: fn(char) -> bool) -> usize {
    characters
        .iter()
        .take_while(|character| accepts(**character))
        .count()
}

fn word_piece(characters: &[char]) -> usize {
    run_of(characters, is_symbol).max(run_of(characters, is_word))
}

fn after(characters: &[char], skipped: usize) -> &[char] {
    characters.get(skipped..).unwrap_or_default()
}

fn rows_up(rows: u64) -> String {
    if rows > 0 {
        format!("\u{1b}[{rows}A")
    } else {
        String::new()
    }
}

fn column_code(column: u64) -> String {
    format!("\u{1b}[{}G", column + 1)
}

fn horizontal(dx: i128) -> String {
    match dx.cmp(&0) {
        std::cmp::Ordering::Equal => String::new(),
        std::cmp::Ordering::Less => format!("\u{1b}[{}D", -dx),
        std::cmp::Ordering::Greater => format!("\u{1b}[{dx}C"),
    }
}

enum Motion {
    Start,
    End,
    Left,
    Right,
    WordLeft,
    WordRight,
}

impl LineEditor {
    #[must_use]
    pub fn new(prompt: &str) -> Self {
        Self {
            prompt: prompt.to_owned(),
            line: Vec::new(),
            cursor: 0,
            prev_rows: 0,
            columns: None,
            undone: Vec::new(),
            redone: Vec::new(),
            kills: Vec::new(),
            kill_cursor: 0,
            yanking: false,
        }
    }

    pub fn set_columns(&mut self, columns: Option<u16>) {
        self.columns = columns.filter(|columns| *columns > 0).map(u64::from);
    }

    fn text(&self) -> String {
        self.line.iter().collect()
    }

    fn cursor_position(&self) -> Position {
        let before: String = self.line.iter().take(self.cursor).collect();

        display_position(&format!("{}{before}", self.prompt), self.columns)
    }

    #[must_use]
    pub fn start(&mut self, dumb: bool) -> String {
        if dumb {
            return self.prompt.clone();
        }

        self.cursor = 0;
        self.refresh()
    }

    #[must_use]
    pub fn refresh(&mut self) -> String {
        let line = format!("{}{}", self.prompt, self.text());
        let shown = display_position(&line, self.columns);
        let cursor = self.cursor_position();
        let up = rows_up(self.prev_rows);
        let space = if shown.cols == 0 { " " } else { "" };
        let column = column_code(cursor.cols);
        let back = rows_up(shown.rows.saturating_sub(cursor.rows));

        self.prev_rows = cursor.rows;
        format!("{up}\u{1b}[1G\u{1b}[0J{line}{space}{column}{back}")
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            line: self.line.clone(),
            cursor: self.cursor,
        }
    }

    fn remember(&mut self) {
        self.undone.push(self.snapshot());

        let excess = self.undone.len().saturating_sub(MAX_UNDO);

        self.undone.drain(..excess);
    }

    fn restore(&mut self, snapshot: Snapshot) -> String {
        self.line = snapshot.line;
        self.cursor = snapshot.cursor;
        self.refresh()
    }

    fn undo(&mut self) -> String {
        let Some(entry) = self.undone.pop() else {
            return String::new();
        };

        self.redone.push(self.snapshot());
        self.restore(entry)
    }

    fn redo(&mut self) -> String {
        let Some(entry) = self.redone.pop() else {
            return String::new();
        };

        self.undone.push(self.snapshot());
        self.restore(entry)
    }

    fn insert(&mut self, text: &[char]) -> String {
        self.remember();

        if self.cursor < self.line.len() {
            self.line
                .splice(self.cursor..self.cursor, text.iter().copied());
            self.cursor += text.len();
            return self.refresh();
        }

        let before = self.cursor_position();

        self.line.extend_from_slice(text);
        self.cursor += text.len();

        if before.rows < self.cursor_position().rows {
            self.refresh()
        } else {
            text.iter().collect()
        }
    }

    fn delete_left(&mut self) -> String {
        if self.cursor == 0 {
            return String::new();
        }

        self.remember();
        self.cursor -= 1;
        self.line.remove(self.cursor);
        self.refresh()
    }

    fn delete_right(&mut self) -> String {
        if self.cursor >= self.line.len() {
            return String::new();
        }

        self.remember();
        self.line.remove(self.cursor);
        self.refresh()
    }

    fn word_left_span(&self) -> usize {
        let reversed: Vec<char> = self.line.iter().take(self.cursor).rev().copied().collect();
        let spaces = run_of(&reversed, is_js_whitespace);

        spaces + word_piece(after(&reversed, spaces))
    }

    fn word_right_span(&self) -> usize {
        let trailing = after(&self.line, self.cursor);
        let piece = run_of(trailing, is_js_whitespace).max(word_piece(trailing));

        piece + run_of(after(trailing, piece), is_js_whitespace)
    }

    fn deleted_right_span(&self) -> usize {
        let trailing = after(&self.line, self.cursor);
        let spaces = run_of(trailing, is_js_whitespace);
        let piece = if spaces > 0 {
            spaces
        } else {
            run_of(trailing, is_not_word).max(run_of(trailing, is_word))
        };

        piece + run_of(after(trailing, piece), is_js_whitespace)
    }

    fn delete_word_left(&mut self) -> String {
        if self.cursor == 0 {
            return String::new();
        }

        self.remember();

        let kept = self.cursor - self.word_left_span();

        self.line.drain(kept..self.cursor);
        self.cursor = kept;
        self.refresh()
    }

    fn delete_word_right(&mut self) -> String {
        if self.cursor >= self.line.len() {
            return String::new();
        }

        self.remember();

        let end = self.cursor + self.deleted_right_span();

        self.line.drain(self.cursor..end);
        self.refresh()
    }

    fn keep_kill(&mut self, killed: Vec<char>) {
        if killed.is_empty() || self.kills.first() == Some(&killed) {
            return;
        }

        self.kills.insert(0, killed);
        self.kill_cursor = 0;
        self.kills.truncate(MAX_KILLS);
    }

    fn delete_line_left(&mut self) -> String {
        self.remember();

        let killed = self.line.drain(..self.cursor).collect();

        self.cursor = 0;
        self.keep_kill(killed);
        self.refresh()
    }

    fn delete_line_right(&mut self) -> String {
        self.remember();

        let killed = self.line.split_off(self.cursor);

        self.keep_kill(killed);
        self.refresh()
    }

    fn yank(&mut self) -> String {
        let Some(text) = self.kills.get(self.kill_cursor).cloned() else {
            return String::new();
        };

        self.yanking = true;
        self.insert(&text)
    }

    fn yank_pop(&mut self) -> String {
        if !self.yanking || self.kills.len() <= 1 {
            return String::new();
        }

        let last = self.kills.get(self.kill_cursor).map_or(0, Vec::len);

        self.kill_cursor = (self.kill_cursor + 1) % self.kills.len();

        let current = self
            .kills
            .get(self.kill_cursor)
            .cloned()
            .unwrap_or_default();
        let start = self.cursor - last;

        self.line
            .splice(start..self.cursor, current.iter().copied());
        self.cursor = start + current.len();
        self.refresh()
    }

    fn motion(&mut self, motion: &Motion) -> String {
        let target = match motion {
            Motion::Start => 0,
            Motion::End => self.line.len(),
            Motion::Left => self.cursor.saturating_sub(1),
            Motion::Right => (self.cursor + 1).min(self.line.len()),
            Motion::WordLeft => self.cursor - self.word_left_span(),
            Motion::WordRight => self.cursor + self.word_right_span(),
        };
        let before = self.cursor_position();

        self.cursor = target;

        let after = self.cursor_position();

        if before.rows == after.rows {
            horizontal(i128::from(after.cols) - i128::from(before.cols))
        } else {
            self.refresh()
        }
    }

    fn clear_screen(&mut self) -> String {
        format!("\u{1b}[1;1H\u{1b}[0J{}", self.refresh())
    }

    #[must_use]
    pub fn finish_line(&mut self) -> String {
        let out = format!("{}\r\n", self.motion(&Motion::End));

        self.line.clear();
        self.cursor = 0;
        self.prev_rows = 0;
        out
    }

    pub fn key(&mut self, key: &KeyEvent) -> (String, LineKey) {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let meta = key.modifiers.contains(KeyModifiers::ALT);
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);

        self.yanking =
            self.yanking && meta && !ctrl && matches!(key.code, KeyCode::Char('y' | 'Y'));

        if ctrl && shift {
            let out = if key.code == KeyCode::Delete {
                self.delete_line_right()
            } else {
                String::new()
            };

            return (out, LineKey::Editing);
        }

        if ctrl {
            return self.control_key(key.code, meta);
        }

        if meta {
            return (self.meta_key(key.code), LineKey::Editing);
        }

        let out = match key.code {
            KeyCode::Enter => {
                let line = self.text();

                return (self.finish_line(), LineKey::Line(line));
            }
            KeyCode::Backspace => self.delete_left(),
            KeyCode::Delete => self.delete_right(),
            KeyCode::Left => self.motion(&Motion::Left),
            KeyCode::Right => self.motion(&Motion::Right),
            KeyCode::Home => self.motion(&Motion::Start),
            KeyCode::End => self.motion(&Motion::End),
            KeyCode::Tab => self.insert(&['\t']),
            KeyCode::Char(character) => self.insert(&[character]),
            _ => String::new(),
        };

        (out, LineKey::Editing)
    }

    fn meta_key(&mut self, code: KeyCode) -> String {
        match code {
            KeyCode::Backspace => self.delete_word_left(),
            KeyCode::Delete | KeyCode::Char('d' | 'D') => self.delete_word_right(),
            KeyCode::Char('b' | 'B') => self.motion(&Motion::WordLeft),
            KeyCode::Char('f' | 'F') => self.motion(&Motion::WordRight),
            KeyCode::Char('y' | 'Y') => self.yank_pop(),
            _ => String::new(),
        }
    }

    fn control_key(&mut self, code: KeyCode, meta: bool) -> (String, LineKey) {
        let letter = match code {
            KeyCode::Left => return (self.motion(&Motion::WordLeft), LineKey::Editing),
            KeyCode::Right => return (self.motion(&Motion::WordRight), LineKey::Editing),
            KeyCode::Delete => return (self.delete_word_right(), LineKey::Editing),
            KeyCode::Char('h') if meta => return (self.delete_word_left(), LineKey::Editing),
            KeyCode::Char(letter) if !meta => letter,
            _ => return (String::new(), LineKey::Editing),
        };

        let out = match letter.to_ascii_lowercase() {
            'c' => return (self.finish_line(), LineKey::Cancelled),
            'd' if self.line.is_empty() => return (String::new(), LineKey::Aborted),
            #[cfg(unix)]
            'z' => return (String::new(), LineKey::Suspended),
            'd' => self.delete_right(),
            'h' => self.delete_left(),
            'u' => self.delete_line_left(),
            'k' => self.delete_line_right(),
            'a' => self.motion(&Motion::Start),
            'e' => self.motion(&Motion::End),
            'b' => self.motion(&Motion::Left),
            'f' => self.motion(&Motion::Right),
            'l' => self.clear_screen(),
            'w' => self.delete_word_left(),
            'y' => self.yank(),
            '4' => self.insert(&[FILE_SEPARATOR]),
            '5' => self.insert(&[GROUP_SEPARATOR]),
            '6' => self.redo(),
            '7' => self.undo(),
            _ => String::new(),
        };

        (out, LineKey::Editing)
    }
}
