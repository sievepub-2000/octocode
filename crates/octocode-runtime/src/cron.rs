//! Minimal 5-field cron expression parser used by the scheduler.
//!
//! Supports: `min hour dom month dow`, where each field accepts:
//!   * `*` — wildcard
//!   * `N` — literal integer
//!   * `N/STEP` — N then every STEP (alias `*/STEP` accepted as `0/STEP`)
//!   * `A-B` — inclusive range
//!   * `A,B,C` — comma list of any of the above
//!
//! Field domains:
//!   minute  0..=59
//!   hour    0..=23
//!   dom     1..=31
//!   month   1..=12
//!   dow     0..=6  (0 = Sunday)
//!
//! No timezone, leap-seconds, or `@reboot` shorthand: keep this MVP
//! within the Octocode "one boundary at a time" rule and resolve every
//! match in UTC seconds. The parser is offline and dependency-free.

use octocode_core::OctoError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronSchedule {
    minutes: Vec<u32>,
    hours: Vec<u32>,
    doms: Vec<u32>,
    months: Vec<u32>,
    dows: Vec<u32>,
}

impl CronSchedule {
    pub fn parse(expr: &str) -> Result<Self, OctoError> {
        let parts: Vec<&str> = expr.split_whitespace().collect();
        if parts.len() != 5 {
            return Err(OctoError::Runtime(format!(
                "cron expression must have 5 whitespace-separated fields, got {}: '{expr}'",
                parts.len()
            )));
        }
        Ok(Self {
            minutes: parse_field(parts[0], 0, 59)?,
            hours: parse_field(parts[1], 0, 23)?,
            doms: parse_field(parts[2], 1, 31)?,
            months: parse_field(parts[3], 1, 12)?,
            dows: parse_field(parts[4], 0, 6)?,
        })
    }

    /// Compute the next unix timestamp strictly greater than `after`
    /// that satisfies the schedule. Searches forward minute-by-minute
    /// and bails out after a full year — that is more than enough for
    /// any reachable cron expression.
    pub fn next_after(&self, after: u64) -> Option<u64> {
        // Start at the next whole minute after `after`.
        let mut t = (after / 60 + 1) * 60;
        let max = after + 366 * 24 * 60 * 60;
        while t <= max {
            let (year, month, day, hour, minute, dow) = unix_to_civil(t);
            let _ = year; // unused but keeps function honest for future tz work.
            if self.minutes.contains(&minute)
                && self.hours.contains(&hour)
                && self.doms.contains(&day)
                && self.months.contains(&month)
                && self.dows.contains(&dow)
            {
                return Some(t);
            }
            t += 60;
        }
        None
    }
}

fn parse_field(expr: &str, lo: u32, hi: u32) -> Result<Vec<u32>, OctoError> {
    let mut out = Vec::new();
    for piece in expr.split(',') {
        let piece = piece.trim();
        if piece.is_empty() {
            return Err(OctoError::Runtime(format!("empty cron field component in '{expr}'")));
        }
        let (range_part, step) = if let Some((left, right)) = piece.split_once('/') {
            let step: u32 = right
                .parse()
                .map_err(|_| OctoError::Runtime(format!("cron step '{right}' not numeric")))?;
            if step == 0 {
                return Err(OctoError::Runtime(format!("cron step in '{piece}' must be > 0")));
            }
            (left, step)
        } else {
            (piece, 1)
        };
        let (start, end) = if range_part == "*" {
            (lo, hi)
        } else if let Some((a, b)) = range_part.split_once('-') {
            let a: u32 = a
                .parse()
                .map_err(|_| OctoError::Runtime(format!("cron range start '{a}' not numeric")))?;
            let b: u32 = b
                .parse()
                .map_err(|_| OctoError::Runtime(format!("cron range end '{b}' not numeric")))?;
            if a < lo || b > hi || a > b {
                return Err(OctoError::Runtime(format!(
                    "cron range {a}-{b} out of {lo}..={hi}"
                )));
            }
            (a, b)
        } else {
            let n: u32 = range_part
                .parse()
                .map_err(|_| OctoError::Runtime(format!("cron value '{range_part}' not numeric")))?;
            if n < lo || n > hi {
                return Err(OctoError::Runtime(format!(
                    "cron value {n} out of {lo}..={hi}"
                )));
            }
            // For `N/STEP` semantics, expand from N to hi by STEP.
            if step > 1 {
                (n, hi)
            } else {
                (n, n)
            }
        };
        let mut v = start;
        while v <= end {
            out.push(v);
            v += step;
        }
    }
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

/// Convert unix seconds to `(year, month, day, hour, minute, weekday)`
/// in UTC. Weekday: 0=Sunday..6=Saturday. Algorithm: Howard Hinnant's
/// civil-from-days, which is exact for any int64 unix time.
fn unix_to_civil(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let secs_of_day = (secs % 86_400) as u32;
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    // Day-of-week: 1970-01-01 was a Thursday (=4 in 0=Sun..6=Sat).
    let dow = ((days + 4).rem_euclid(7)) as u32;

    // Hinnant civil-from-days, shifted so that the era starts at 0000-03-01.
    let z = days + 719_468;
    let era = if z >= 0 { z / 146_097 } else { (z - 146_096) / 146_097 };
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    (year as i32, m as u32, d as u32, hour, minute, dow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_wrong_field_count() {
        assert!(CronSchedule::parse("* * *").is_err());
        assert!(CronSchedule::parse("* * * * * *").is_err());
    }

    #[test]
    fn parses_wildcards_and_steps() {
        let s = CronSchedule::parse("*/15 * * * *").unwrap();
        assert_eq!(s.minutes, vec![0, 15, 30, 45]);
        assert_eq!(s.hours.len(), 24);
        assert_eq!(s.doms.len(), 31);
        assert_eq!(s.months.len(), 12);
        assert_eq!(s.dows.len(), 7);
    }

    #[test]
    fn parses_ranges_and_lists() {
        let s = CronSchedule::parse("0,30 9-17 * * 1-5").unwrap();
        assert_eq!(s.minutes, vec![0, 30]);
        assert_eq!(s.hours, vec![9, 10, 11, 12, 13, 14, 15, 16, 17]);
        assert_eq!(s.dows, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn rejects_out_of_range_values() {
        assert!(CronSchedule::parse("60 * * * *").is_err());
        assert!(CronSchedule::parse("* 24 * * *").is_err());
        assert!(CronSchedule::parse("* * 32 * *").is_err());
        assert!(CronSchedule::parse("* * * 13 *").is_err());
        assert!(CronSchedule::parse("* * * * 7").is_err());
    }

    #[test]
    fn next_after_advances_to_next_minute_for_wildcard() {
        let s = CronSchedule::parse("* * * * *").unwrap();
        // At 1700000123 (some Friday afternoon UTC), next match is the
        // next whole minute — 1700000160.
        let n = s.next_after(1_700_000_123).unwrap();
        assert_eq!(n % 60, 0);
        assert!(n > 1_700_000_123);
        assert!(n - 1_700_000_123 <= 60);
    }

    #[test]
    fn next_after_picks_specific_minute() {
        // 0 9 * * 1-5  -- weekdays at 09:00 UTC.
        let s = CronSchedule::parse("0 9 * * 1-5").unwrap();
        let next = s.next_after(0).unwrap();
        let (_, _, _, h, m, dow) = unix_to_civil(next);
        assert_eq!(h, 9);
        assert_eq!(m, 0);
        assert!((1..=5).contains(&dow));
    }

    #[test]
    fn unix_to_civil_known_anchors() {
        // 1970-01-01 00:00:00 UTC == Thursday.
        let (y, mo, d, h, mi, dow) = unix_to_civil(0);
        assert_eq!((y, mo, d, h, mi, dow), (1970, 1, 1, 0, 0, 4));
        // 2000-01-01 00:00:00 UTC == Saturday.
        let (y, mo, d, _, _, dow) = unix_to_civil(946_684_800);
        assert_eq!((y, mo, d, dow), (2000, 1, 1, 6));
    }
}
