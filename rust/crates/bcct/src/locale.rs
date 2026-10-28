#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Locale {
    #[default]
    EnUs,
    PtBr,
}

impl Locale {
    pub const ALL: [Self; 2] = [Self::EnUs, Self::PtBr];

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|locale| locale.as_str() == value)
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EnUs => "en-us",
            Self::PtBr => "pt-br",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_two_codes_the_config_stores() {
        assert_eq!(Locale::parse("en-us"), Some(Locale::EnUs));
        assert_eq!(Locale::parse("pt-br"), Some(Locale::PtBr));
    }

    #[test]
    fn refuses_any_other_spelling_like_the_js_includes_check() {
        for value in ["", "en", "pt", "EN-US", "pt-BR", "pt_br", " en-us"] {
            assert_eq!(Locale::parse(value), None, "{value:?}");
        }
    }

    #[test]
    fn defaults_to_en_us() {
        assert_eq!(Locale::default(), Locale::EnUs);
    }

    #[test]
    fn writes_back_the_same_code_it_parses() {
        for locale in Locale::ALL {
            assert_eq!(Locale::parse(locale.as_str()), Some(locale));
        }
    }
}
