//! Protected descriptor input, with an explicit disabled central branch and no remote transport.
//!
//! The current launcher still emits only a plain local-owner link. Structured inputs can never become local links or
//! request the classic local-owner fallback. A central payload is shape-checked, its token dropped, and unavailable.
use serde::{Deserialize, Deserializer};
use std::fmt;
use std::io::Read;
use toolroll_api::{ConnectionBinding, CONNECTION_PROTOCOL};
use url::Url;
use zeroize::Zeroizing;

pub const MAX_BOOTSTRAP_BYTES: usize = 4096;
/// Not EXIT_CLASSIC (42), EXIT_UNPROTECTED (43), stop (40), keep (41) or session-ended (1).
/// The existing Node wrapper maps this post-protected-handoff code to ordinary leave.
pub const EXIT_CENTRAL_UNAVAILABLE: i32 = 44;
pub const CENTRAL_UNAVAILABLE: &str =
    "Central terminal connections are not available in this build.";

pub struct CentralToken {
    pub origin: String,
    pub binding: ConnectionBinding,
    pub token: Zeroizing<String>,
}

impl fmt::Debug for CentralToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CentralToken { origin: <held>, binding: <held>, token: <held> }")
    }
}

pub enum Bootstrap {
    LocalLink(Zeroizing<String>),
    /// Verified central-workspace token bootstrap, held in zeroizing memory until connected and dropped.
    CentralToken(CentralToken),
}

impl fmt::Debug for Bootstrap {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::LocalLink(_) => "Bootstrap::LocalLink(<held>)",
            Self::CentralToken(_) => "Bootstrap::CentralToken(<held>)",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootstrapError {
    Unreadable,
    TooLarge,
    Invalid,
    Unsupported,
}

impl fmt::Display for BootstrapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Serde/URL errors may include input values. Only these static messages leave the parser.
        f.write_str(match self {
            Self::Unreadable => "The terminal sign-in could not be read.",
            Self::TooLarge => "The terminal sign-in is too large.",
            Self::Invalid => "The central terminal sign-in is invalid.",
            Self::Unsupported => "This central terminal sign-in protocol is not supported.",
        })
    }
}

impl std::error::Error for BootstrapError {}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum CentralKind {
    CentralToken,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum BindingKind {
    EnrolledPerson,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Binding {
    kind: BindingKind,
    workspace_id: String,
    recovery_generation: String,
    account: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CentralBootstrap {
    bootstrap: u32,
    kind: CentralKind,
    connection_protocol: u32,
    origin: String,
    binding: Binding,
    #[serde(deserialize_with = "secret")]
    token: Zeroizing<String>,
}

fn secret<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Zeroizing<String>, D::Error> {
    String::deserialize(deserializer).map(Zeroizing::new)
}

fn person_token(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 59
        && &bytes[..3] == b"so_"
        && bytes[15] == b'_'
        && bytes[3..15]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        && bytes[16..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(b))
}

fn canonical_https_origin(origin: &str) -> bool {
    let Ok(url) = Url::parse(origin) else {
        return false;
    };
    url.scheme() == "https"
        && url.host().is_some()
        && !url.cannot_be_a_base()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && url.origin().ascii_serialization() == origin
}

/// The borrowed input must itself be held privately; `read` uses a zeroizing bounded buffer.
pub fn parse(input: &str) -> Result<Option<Bootstrap>, BootstrapError> {
    if input.len() > MAX_BOOTSTRAP_BYTES {
        return Err(BootstrapError::TooLarge);
    }
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        // This disabled FD spelling accepts literal UTF-8 strings only. Reject all escapes BEFORE serde can decode a
        // token into its ordinary scratch buffer; no escaped key, prefix or token character can reach deserialization.
        // The general metadata contract can represent more printable names; this bootstrap deliberately does not yet
        // admit JSON-escaped spellings. The current launcher emits neither form of central bootstrap.
        if trimmed.as_bytes().contains(&b'\\') {
            return Err(BootstrapError::Invalid);
        }
        // A strict struct, not Value or an internally-tagged enum: duplicate fields refuse and the token is wrapped in
        // Zeroizing immediately on deserialization, including when a later field makes the object invalid.
        let central: CentralBootstrap =
            serde_json::from_str(trimmed).map_err(|_| BootstrapError::Invalid)?;
        if central.bootstrap != 1 || central.connection_protocol != CONNECTION_PROTOCOL {
            return Err(BootstrapError::Unsupported);
        }
        let _kind = (&central.kind, &central.binding.kind);
        if !canonical_https_origin(&central.origin) || !person_token(&central.token) {
            return Err(BootstrapError::Invalid);
        }
        let binding = ConnectionBinding::new(
            &central.binding.workspace_id,
            &central.binding.recovery_generation,
            &central.binding.account,
        )
        .map_err(|_| BootstrapError::Invalid)?;
        return Ok(Some(Bootstrap::CentralToken(CentralToken {
            origin: central.origin,
            binding,
            token: central.token,
        })));
    }
    // Preserve the current plain-link handoff's first-line/trim semantics and leave link validation to local redeem.
    let first = input.lines().next().unwrap_or("").trim();
    Ok((!first.is_empty()).then(|| Bootstrap::LocalLink(Zeroizing::new(first.to_owned()))))
}

/// Consume only a bounded descriptor payload. The owning File is closed by its caller on return.
pub fn read(mut reader: impl Read) -> Result<Option<Bootstrap>, BootstrapError> {
    let mut bytes = Zeroizing::new(Vec::with_capacity(MAX_BOOTSTRAP_BYTES + 1));
    (&mut reader)
        .take((MAX_BOOTSTRAP_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| BootstrapError::Unreadable)?;
    if bytes.len() > MAX_BOOTSTRAP_BYTES {
        return Err(BootstrapError::TooLarge);
    }
    let input = std::str::from_utf8(&bytes).map_err(|_| BootstrapError::Invalid)?;
    parse(input)
}
