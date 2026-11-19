const MONTH_NAMES: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];
const WEEKDAY_NAMES: [&str; 7] = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];
const DAYS_IN_MONTH: [u32; 12] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MARKER: &str = "resets";
const ZONE_EXTRA_CHARS: &str = "/_+-:. ";
const ZONE_MAX_CHARS: usize = 64;
const MIN_NAME_LETTERS: usize = 3;
const HOURS_PER_HALF_DAY: u32 = 12;
const HOURS_PER_DAY: u32 = 24;
const MINUTES_PER_HOUR: u32 = 60;
const TIME_DIGITS_MAX: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Clock {
    pub hour: u32,
    pub minute: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Moment {
    Today(Clock),
    Dated { month: u32, day: u32, clock: Clock },
    Weekday { weekday: u32, clock: Clock },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reset {
    pub moment: Moment,
    pub zone: Option<String>,
}

fn name_matches(token: &str, names: &[&str]) -> Option<usize> {
    if token.chars().count() < MIN_NAME_LETTERS {
        return None;
    }

    names.iter().position(|name| name.starts_with(token))
}

fn day_of(token: &str, month_index: usize) -> Option<u32> {
    let digits = token.trim_end_matches(|character: char| character.is_ascii_alphabetic());
    let last_day = DAYS_IN_MONTH.get(month_index).copied()?;

    digits
        .parse::<u32>()
        .ok()
        .filter(|day| (1..=last_day).contains(day))
}

fn split_meridiem(token: &str) -> (&str, Option<bool>) {
    if let Some(body) = token.strip_suffix("am") {
        (body, Some(false))
    } else if let Some(body) = token.strip_suffix("pm") {
        (body, Some(true))
    } else {
        (token, None)
    }
}

fn meridiem_word(token: &str) -> Option<bool> {
    match token {
        "am" => Some(false),
        "pm" => Some(true),
        _ => None,
    }
}

fn digits(text: &str) -> Option<u32> {
    if text.is_empty()
        || text.len() > TIME_DIGITS_MAX
        || !text.chars().all(|character| character.is_ascii_digit())
    {
        return None;
    }

    text.parse().ok()
}

fn clock_of(token: &str, next: Option<&str>) -> Option<Clock> {
    let (body, suffix) = split_meridiem(token);
    let pm = suffix.or_else(|| next.and_then(meridiem_word));
    let (hour_text, minute_text) = body.split_once(':').unwrap_or((body, ""));
    let hour = digits(hour_text)?;
    let minute = if body.contains(':') {
        digits(minute_text)
            .filter(|minute| minute_text.len() == TIME_DIGITS_MAX && *minute < MINUTES_PER_HOUR)?
    } else {
        0
    };

    match pm {
        Some(afternoon) => {
            if hour == 0 || hour > HOURS_PER_HALF_DAY {
                return None;
            }

            Some(Clock {
                hour: hour % HOURS_PER_HALF_DAY + if afternoon { HOURS_PER_HALF_DAY } else { 0 },
                minute,
            })
        }
        None if body.contains(':') && hour < HOURS_PER_DAY => Some(Clock { hour, minute }),
        None => None,
    }
}

fn takes_the_next_word(token: &str, next: Option<&str>) -> bool {
    split_meridiem(token).1.is_none() && next.and_then(meridiem_word).is_some()
}

fn looks_like_time(token: &str, next: Option<&str>) -> bool {
    token.starts_with(|character: char| character.is_ascii_digit())
        && (token.contains(':')
            || split_meridiem(token).1.is_some()
            || takes_the_next_word(token, next))
}

fn is_separator(character: char) -> bool {
    character.is_whitespace() || matches!(character, ',' | '(' | ')' | '·')
}

fn tokens_of(text: &str) -> Vec<(String, usize)> {
    let mut tokens = Vec::new();
    let mut start: Option<usize> = None;

    for (index, character) in text.char_indices() {
        if is_separator(character) {
            if let Some(begin) = start.take() {
                tokens.push((text[begin..index].to_lowercase(), index));
            }
        } else if start.is_none() {
            start = Some(index);
        }
    }

    if let Some(begin) = start {
        tokens.push((text[begin..].to_lowercase(), text.len()));
    }

    tokens
}

fn after_marker(text: &str) -> Option<&str> {
    text.char_indices()
        .map(|(index, _)| index)
        .find(|index| {
            text.get(*index..index + MARKER.len())
                .is_some_and(|word| word.eq_ignore_ascii_case(MARKER))
        })
        .map(|index| &text[index + MARKER.len()..])
}

fn zone_after(rest: &str) -> Option<String> {
    let inner = rest.trim_start().strip_prefix('(')?;
    let (zone, _) = inner.split_once(')')?;
    let zone = zone.trim();
    let readable = !zone.is_empty()
        && zone.chars().count() <= ZONE_MAX_CHARS
        && zone
            .chars()
            .all(|character| character.is_alphanumeric() || ZONE_EXTRA_CHARS.contains(character));

    readable.then(|| zone.to_owned())
}

#[must_use]
pub fn parse(text: &str) -> Option<Reset> {
    let after = after_marker(text)?;
    let tokens = tokens_of(after);
    let mut date: Option<(u32, u32)> = None;
    let mut weekday: Option<u32> = None;
    let mut index = 0;

    while let Some((token, _)) = tokens.get(index) {
        index += 1;

        if matches!(token.as_str(), "at" | "on") {
            continue;
        }

        if let Some(month) = name_matches(token, &MONTH_NAMES) {
            let day = tokens
                .get(index)
                .and_then(|(word, _)| day_of(word, month))?;
            index += 1;
            date = Some((u32::try_from(month).ok()? + 1, day));
            continue;
        }

        if let Some(day_of_week) = name_matches(token, &WEEKDAY_NAMES) {
            weekday = Some(u32::try_from(day_of_week).ok()?);
            continue;
        }

        let next = tokens.get(index).map(|(word, _)| word.as_str());

        if looks_like_time(token, next) {
            let clock = clock_of(token, next)?;
            let last = index - 1 + usize::from(takes_the_next_word(token, next));
            let end = tokens.get(last).map_or(after.len(), |(_, end)| *end);
            let moment = match (date, weekday) {
                (Some((month, day)), _) => Moment::Dated { month, day, clock },
                (None, Some(weekday)) => Moment::Weekday { weekday, clock },
                (None, None) => Moment::Today(clock),
            };

            return Some(Reset {
                moment,
                zone: zone_after(&after[end..]),
            });
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clock(hour: u32, minute: u32) -> Clock {
        Clock { hour, minute }
    }

    fn at(text: &str) -> Option<Reset> {
        parse(text)
    }

    fn moment(text: &str) -> Option<Moment> {
        parse(text).map(|reset| reset.moment)
    }

    fn zone(text: &str) -> Option<String> {
        parse(text).and_then(|reset| reset.zone)
    }

    #[test]
    fn reads_the_time_and_zone_of_the_real_session_limit_text() {
        assert_eq!(
            at("You've hit your session limit · resets 2:20pm (America/Sao_Paulo)"),
            Some(Reset {
                moment: Moment::Today(clock(14, 20)),
                zone: Some("America/Sao_Paulo".to_owned()),
            })
        );
    }

    #[test]
    fn reads_the_time_of_the_wait_line_with_limit_resets() {
        assert_eq!(
            at("Usage limit reached · limit resets 3:45pm"),
            Some(Reset {
                moment: Moment::Today(clock(15, 45)),
                zone: None,
            })
        );
    }

    #[test]
    fn reads_every_twelve_hour_shape() {
        for (text, expected) in [
            ("resets 2pm", clock(14, 0)),
            ("resets 2 pm", clock(14, 0)),
            ("resets 2:05 PM", clock(14, 5)),
            ("resets 12am", clock(0, 0)),
            ("resets 12:30am", clock(0, 30)),
            ("resets 12pm", clock(12, 0)),
            ("RESETS 11:59PM", clock(23, 59)),
            ("resets at 9am", clock(9, 0)),
        ] {
            assert_eq!(moment(text), Some(Moment::Today(expected)), "{text}");
        }
    }

    #[test]
    fn reads_a_twenty_four_hour_time() {
        assert_eq!(moment("resets 14:20"), Some(Moment::Today(clock(14, 20))));
        assert_eq!(moment("resets 0:05"), Some(Moment::Today(clock(0, 5))));
        assert_eq!(
            at("resets 23:59 (UTC)"),
            Some(Reset {
                moment: Moment::Today(clock(23, 59)),
                zone: Some("UTC".to_owned()),
            })
        );
    }

    #[test]
    fn reads_a_date_before_the_time() {
        assert_eq!(
            at("You've hit your weekly limit · resets Nov 24, 9am (America/Sao_Paulo)"),
            Some(Reset {
                moment: Moment::Dated {
                    month: 11,
                    day: 24,
                    clock: clock(9, 0)
                },
                zone: Some("America/Sao_Paulo".to_owned()),
            })
        );
        assert_eq!(
            moment("resets on September 3rd at 10:30am"),
            Some(Moment::Dated {
                month: 9,
                day: 3,
                clock: clock(10, 30)
            })
        );
        assert_eq!(
            moment("resets Sept 3 4pm"),
            Some(Moment::Dated {
                month: 9,
                day: 3,
                clock: clock(16, 0)
            })
        );
    }

    #[test]
    fn reads_the_weekday_and_the_time_of_a_weekday_reset() {
        assert_eq!(
            at("resets Mon 9am (America/Sao_Paulo)"),
            Some(Reset {
                moment: Moment::Weekday {
                    weekday: 0,
                    clock: clock(9, 0)
                },
                zone: Some("America/Sao_Paulo".to_owned()),
            })
        );
        assert_eq!(
            moment("resets on friday at 9:00am"),
            Some(Moment::Weekday {
                weekday: 4,
                clock: clock(9, 0)
            })
        );
        assert_eq!(
            moment("resets Sun 11:30 PM"),
            Some(Moment::Weekday {
                weekday: 6,
                clock: clock(23, 30)
            })
        );
    }

    #[test]
    fn prefers_the_date_when_the_text_has_a_weekday_and_a_date() {
        assert_eq!(
            moment("resets Mon, Nov 24, 9am"),
            Some(Moment::Dated {
                month: 11,
                day: 24,
                clock: clock(9, 0)
            })
        );
    }

    #[test]
    fn reads_the_zone_exactly_as_the_text_gives_it() {
        for (text, expected) in [
            (
                "resets 2:20pm (America/Sao_Paulo)",
                Some("America/Sao_Paulo"),
            ),
            ("resets 2:20pm (UTC)", Some("UTC")),
            ("resets 2:20pm (GMT+2)", Some("GMT+2")),
            ("resets 2:20pm (Etc/GMT-3)", Some("Etc/GMT-3")),
            (
                "resets 2:20pm ( America/Sao_Paulo )",
                Some("America/Sao_Paulo"),
            ),
            ("resets 2 pm (UTC)", Some("UTC")),
            ("resets 2:20pm   (utc)", Some("utc")),
            ("resets 2:20pm (Pacific Time)", Some("Pacific Time")),
            ("resets Nov 24, 9am (Europe/Paris)", Some("Europe/Paris")),
            ("resets Mon 9am (Asia/Tokyo)", Some("Asia/Tokyo")),
        ] {
            assert_eq!(zone(text).as_deref(), expected, "{text}");
        }
    }

    #[test]
    fn gives_no_zone_when_the_text_has_none_or_it_is_unreadable() {
        let long = format!("resets 2:20pm ({})", "a".repeat(ZONE_MAX_CHARS + 1));

        for text in [
            "resets 2:20pm",
            "resets 2:20pm ()",
            "resets 2:20pm (   )",
            "resets 2:20pm (America/Sao_Paulo",
            "resets 2:20pm · (America/Sao_Paulo)",
            "resets 2:20pm later (America/Sao_Paulo)",
            "resets 2:20pm (<b>x</b>)",
            "resets 2:20pm (a&b)",
            "resets (America/Sao_Paulo) 2:20pm",
            long.as_str(),
        ] {
            assert_eq!(zone(text), None, "{text}");
        }

        assert_eq!(
            moment("resets 2:20pm (<b>x</b>)"),
            Some(Moment::Today(clock(14, 20)))
        );
    }

    #[test]
    fn keeps_a_zone_of_the_longest_length_allowed() {
        let edge = "a".repeat(ZONE_MAX_CHARS);

        assert_eq!(
            zone(&format!("resets 2:20pm ({edge})")).as_deref(),
            Some(edge.as_str())
        );
    }

    #[test]
    fn finds_the_marker_after_characters_that_change_length_when_lowercased() {
        assert_eq!(
            at("İİ limit resets 2:20pm (UTC)"),
            Some(Reset {
                moment: Moment::Today(clock(14, 20)),
                zone: Some("UTC".to_owned()),
            })
        );
    }

    #[test]
    fn gives_nothing_without_a_readable_time() {
        for text in [
            "",
            "API Error: Rate limit reached",
            "resets",
            "resets soon",
            "resets in 3 hours",
            "resets Nov 24",
            "resets Nov",
            "resets Nov x 9am",
            "resets Nov 32, 9am",
            "resets Nov 0, 9am",
            "resets Feb 30, 9am",
            "resets Apr 31, 9am",
            "9am but no marker",
        ] {
            assert_eq!(at(text), None, "{text:?}");
        }
    }

    #[test]
    fn accepts_the_last_day_of_each_month() {
        for (month, name, last) in [
            (1, "Jan", 31),
            (2, "Feb", 29),
            (4, "Apr", 30),
            (12, "Dec", 31),
        ] {
            assert_eq!(
                moment(&format!("resets {name} {last}, 9am")),
                Some(Moment::Dated {
                    month,
                    day: last,
                    clock: clock(9, 0)
                }),
                "{name}"
            );
            assert_eq!(
                moment(&format!("resets {name} {}, 9am", last + 1)),
                None,
                "{name}"
            );
        }
    }

    #[test]
    fn gives_nothing_for_a_malformed_time() {
        for text in [
            "resets 25:00",
            "resets 24:00",
            "resets 13pm",
            "resets 0pm",
            "resets 0am",
            "resets 2:60pm",
            "resets 2:5pm",
            "resets 2:xxpm",
            "resets 123:45",
            "resets 2:345pm",
            "resets 99:99pm",
            "resets 2:",
            "resets :30pm",
            "resets 2:30:15pm",
        ] {
            assert_eq!(at(text), None, "{text:?}");
        }
    }

    #[test]
    fn ignores_short_words_that_start_like_a_month_or_weekday() {
        assert_eq!(moment("resets ma 9am"), Some(Moment::Today(clock(9, 0))));
        assert_eq!(moment("resets mo 9am"), Some(Moment::Today(clock(9, 0))));
    }
}
