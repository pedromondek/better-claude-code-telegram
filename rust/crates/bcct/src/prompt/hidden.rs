use crate::js::js_trim;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HiddenKey {
    Typing,
    Done(String),
    Cancelled,
}

#[derive(Debug, Default)]
pub struct Hidden {
    typed: Vec<u16>,
}

impl Hidden {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn chunk(&mut self, bytes: &[u8]) -> HiddenKey {
        for character in String::from_utf8_lossy(bytes).chars() {
            match character {
                '\r' | '\n' => {
                    let typed = String::from_utf16_lossy(&self.typed);

                    return HiddenKey::Done(js_trim(&typed).to_owned());
                }
                '\u{3}' => return HiddenKey::Cancelled,
                '\u{7f}' | '\u{8}' => {
                    self.typed.pop();
                }
                other => {
                    let mut units = [0; 2];

                    self.typed.extend_from_slice(other.encode_utf16(&mut units));
                }
            }
        }

        HiddenKey::Typing
    }
}
