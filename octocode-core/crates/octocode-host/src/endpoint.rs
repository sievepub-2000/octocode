//! Choosing between several addresses for the same model server.
//!
//! A model host is often reachable over more than one path — machine 3 reaches
//! the GB10 both over a direct gigabit cable (`10.10.10.2` / `fd00:10:10::2`)
//! and over Wi-Fi (`192.168.10.2`). The cable is an order of magnitude faster
//! but it is a point-to-point link with no DHCP, so it disappears whenever the
//! cable is unplugged and the session must fall back to Wi-Fi rather than fail.
//!
//! A base URL may therefore be written as a comma-separated preference list:
//!
//! ```text
//! http://10.10.10.2:8000/v1,http://192.168.10.2:8000/v1
//! ```
//!
//! The first entry that accepts a TCP connection wins; if none do, the first
//! entry is used unchanged so the model call fails with the provider's own
//! error instead of one invented here.

use std::{
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    time::Duration,
};

/// How long a single candidate gets to accept a connection. A direct cable
/// answers in well under a millisecond and Wi-Fi on the same subnet in a few,
/// so a short budget keeps task startup responsive when the cable is unplugged.
const PROBE_TIMEOUT: Duration = Duration::from_millis(400);

/// Splits a preference list into individual base URLs, discarding blanks.
pub fn split_candidates(base_url: &str) -> Vec<&str> {
    base_url
        .split(',')
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
        .collect()
}

/// Host and port to probe for a base URL, or `None` when it cannot be parsed.
pub fn probe_target(base_url: &str) -> Option<(String, u16)> {
    let (scheme, rest) = base_url.split_once("://")?;
    let default_port = match scheme {
        "http" => 80,
        "https" => 443,
        _ => return None,
    };
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    if let Some(rest) = authority.strip_prefix('[') {
        // IPv6 literal: `[fd00:10:10::2]:8000`
        let (host, tail) = rest.split_once(']')?;
        let port = tail
            .strip_prefix(':')
            .and_then(|port| port.parse().ok())
            .unwrap_or(default_port);
        return Some((host.to_owned(), port));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() => {
            Some((host.to_owned(), port.parse().unwrap_or(default_port)))
        }
        _ => Some((authority.to_owned(), default_port)),
    }
}

fn is_reachable(base_url: &str) -> bool {
    let Some((host, port)) = probe_target(base_url) else {
        return false;
    };
    let Ok(addresses) = (host.as_str(), port).to_socket_addrs() else {
        return false;
    };
    addresses
        .collect::<Vec<SocketAddr>>()
        .iter()
        .any(|address| TcpStream::connect_timeout(address, PROBE_TIMEOUT).is_ok())
}

/// Picks the first reachable entry of a preference list.
///
/// Falls back to the first entry when nothing answers, so the caller still
/// produces a well-formed configuration and the failure surfaces as the model
/// provider's own connection error.
pub fn select_base_url(base_url: &str) -> String {
    select_base_url_with(base_url, is_reachable)
}

pub fn select_base_url_with(base_url: &str, reachable: impl Fn(&str) -> bool) -> String {
    let candidates = split_candidates(base_url);
    let Some(&first) = candidates.first() else {
        return base_url.trim().to_owned();
    };
    // Nothing to choose between: skip the probe (up to 400 ms per run).
    if candidates.len() == 1 {
        return first.to_owned();
    }
    candidates
        .iter()
        .find(|candidate| reachable(candidate))
        .map_or_else(|| first.to_owned(), |candidate| (*candidate).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_single_url_is_used_as_is() {
        assert_eq!(
            select_base_url_with("http://192.168.10.2:8000/v1", |_| false),
            "http://192.168.10.2:8000/v1"
        );
    }

    #[test]
    fn the_direct_link_wins_while_the_cable_is_connected() {
        let list = "http://10.10.10.2:8000/v1, http://192.168.10.2:8000/v1";
        assert_eq!(
            select_base_url_with(list, |url| url.contains("10.10.10.2")),
            "http://10.10.10.2:8000/v1"
        );
    }

    #[test]
    fn wifi_takes_over_when_the_cable_is_unplugged() {
        let list = "http://10.10.10.2:8000/v1, http://192.168.10.2:8000/v1";
        assert_eq!(
            select_base_url_with(list, |url| url.contains("192.168.10.2")),
            "http://192.168.10.2:8000/v1"
        );
    }

    #[test]
    fn an_unreachable_list_still_produces_the_preferred_entry() {
        // The task must fail with the provider's connection error, not with a
        // malformed configuration written by this host.
        let list = "http://10.10.10.2:8000/v1,http://192.168.10.2:8000/v1";
        assert_eq!(
            select_base_url_with(list, |_| false),
            "http://10.10.10.2:8000/v1"
        );
    }

    #[test]
    fn blank_entries_are_ignored() {
        let list = " ,http://10.10.10.2:8000/v1, ,http://192.168.10.2:8000/v1,";
        assert_eq!(
            split_candidates(list),
            vec!["http://10.10.10.2:8000/v1", "http://192.168.10.2:8000/v1"]
        );
    }

    #[test]
    fn probes_the_authority_of_each_supported_url_shape() {
        assert_eq!(
            probe_target("http://10.10.10.2:8000/v1"),
            Some(("10.10.10.2".into(), 8000))
        );
        assert_eq!(
            probe_target("http://[fd00:10:10::2]:8000/v1"),
            Some(("fd00:10:10::2".into(), 8000))
        );
        assert_eq!(
            probe_target("https://api.example.com/v1"),
            Some(("api.example.com".into(), 443))
        );
        assert_eq!(
            probe_target("http://api.example.com/v1"),
            Some(("api.example.com".into(), 80))
        );
        assert_eq!(probe_target("ftp://example.com"), None);
    }
}
