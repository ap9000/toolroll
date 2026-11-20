//! Disabled remote-connection metadata only: no HTTP client, credential, bootstrap or action authority.
//!
//! The separate connection protocol does not change the local engine handshake. A caller supplies bindings from its
//! trusted enrolled profile; response values never establish or silently replace those bindings. This slice accepts
//! only the all-disabled scaffold. Parsing it grants no read, action, approval, local execution or terminal access.
use crate::models::{contract_digest, API_VERSION};
use serde::{Deserialize, Serialize};
use std::fmt;

pub const CONNECTION_PROTOCOL: u32 = 1;
pub const MAX_CONNECTION_METADATA_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionError {
    BodyTooLarge,
    MalformedMetadata,
    UnsupportedProtocol,
    InvalidWorkspace,
    InvalidPrincipal,
    InvalidEngine,
    InvalidBinding,
    WorkspaceMismatch,
    RecoveryChanged,
    AccountMismatch,
    CapabilitiesEnabled,
}

impl fmt::Display for ConnectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never include a response, serde error, profile value or unknown field: it may contain credential-like text.
        f.write_str(match self {
            Self::BodyTooLarge => "The connection answer is too large.",
            Self::MalformedMetadata => "The connection answer is not this protocol's shape.",
            Self::UnsupportedProtocol => "This connection protocol is not supported.",
            Self::InvalidWorkspace => "The connection workspace identity is invalid.",
            Self::InvalidPrincipal => "The connection person is invalid.",
            Self::InvalidEngine => "The workspace uses another engine contract.",
            Self::InvalidBinding => "The enrolled connection binding is invalid.",
            Self::WorkspaceMismatch => "This is not the enrolled workspace.",
            Self::RecoveryChanged => "The workspace recovery identity changed; sign in again.",
            Self::AccountMismatch => "This is not the enrolled account.",
            Self::CapabilitiesEnabled => "Remote capabilities are not enabled by this scaffold.",
        })
    }
}

impl std::error::Error for ConnectionError {}

/// Expected values must come from the protected enrolled profile, never from the response being checked.
#[derive(Clone, PartialEq, Eq)]
pub struct ConnectionBinding {
    workspace_id: String,
    recovery_generation: String,
    account: String,
}

impl fmt::Debug for ConnectionBinding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ConnectionBinding { workspace: <held>, recovery: <held>, account: <held> }")
    }
}

impl ConnectionBinding {
    pub fn new(
        workspace_id: &str,
        recovery_generation: &str,
        account: &str,
    ) -> Result<Self, ConnectionError> {
        if !uuid_v4(workspace_id) || !lower_hex(recovery_generation, 32) || !printable(account) {
            return Err(ConnectionError::InvalidBinding);
        }
        Ok(Self {
            workspace_id: workspace_id.to_owned(),
            recovery_generation: recovery_generation.to_owned(),
            account: account.to_owned(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionRole {
    Viewer,
    Approver,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionAccess {
    Read,
    Act,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionRefusal {
    Request,
    Unauthenticated,
    CredentialPurpose,
    WorkspaceUnavailable,
    ContractUnavailable,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Refusal {
    protocol: u32,
    error: ConnectionRefusal,
}

pub fn parse_connection_refusal(body: &str) -> Result<ConnectionRefusal, ConnectionError> {
    if body.len() > MAX_CONNECTION_METADATA_BYTES {
        return Err(ConnectionError::BodyTooLarge);
    }
    let refusal: Refusal =
        serde_json::from_str(body).map_err(|_| ConnectionError::MalformedMetadata)?;
    if refusal.protocol != CONNECTION_PROTOCOL {
        return Err(ConnectionError::UnsupportedProtocol);
    }
    Ok(refusal.error)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Workspace {
    id: String,
    recovery_generation: String,
    label: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Principal {
    account: String,
    role: ConnectionRole,
    access: ConnectionAccess,
    expires_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Engine {
    version: u32,
    contract: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Capabilities {
    work_rows: bool,
    step_cards: bool,
    result_diff: bool,
    run_live_window: bool,
    commands: Vec<String>,
    approval: Approval,
    provider_setup: bool,
    local_code: bool,
    local_execution: bool,
    interactive: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Approval {
    Browser,
}

impl Capabilities {
    fn disabled(&self) -> bool {
        !self.work_rows
            && !self.step_cards
            && !self.result_diff
            && !self.run_live_window
            && self.commands.is_empty()
            && !self.provider_setup
            && !self.local_code
            && !self.local_execution
            && !self.interactive
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    protocol: u32,
    workspace: Workspace,
    principal: Principal,
    engine: Engine,
    capabilities: Capabilities,
}

/// Validated identity metadata whose capabilities are all disabled. This type is not an execution/read permit.
#[derive(Clone, Serialize)]
#[serde(transparent)]
pub struct DisabledConnection(Metadata);

impl fmt::Debug for DisabledConnection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DisabledConnection { identity: <held>, capabilities: disabled }")
    }
}

impl DisabledConnection {
    pub fn workspace_id(&self) -> &str {
        &self.0.workspace.id
    }
    pub fn recovery_generation(&self) -> &str {
        &self.0.workspace.recovery_generation
    }
    pub fn label(&self) -> &str {
        &self.0.workspace.label
    }
    pub fn account(&self) -> &str {
        &self.0.principal.account
    }
    pub fn role(&self) -> ConnectionRole {
        self.0.principal.role
    }
    pub fn access(&self) -> ConnectionAccess {
        self.0.principal.access
    }
    pub fn expires_at(&self) -> &str {
        &self.0.principal.expires_at
    }

    /// This metadata is not authority. Check its enrolled identity and exact local engine contract independently.
    pub fn check_binding(&self, expected: &ConnectionBinding) -> Result<(), ConnectionError> {
        if self.0.workspace.id != expected.workspace_id {
            return Err(ConnectionError::WorkspaceMismatch);
        }
        if self.0.workspace.recovery_generation != expected.recovery_generation {
            return Err(ConnectionError::RecoveryChanged);
        }
        if self.0.principal.account != expected.account {
            return Err(ConnectionError::AccountMismatch);
        }
        if self.0.engine.contract != contract_digest() {
            return Err(ConnectionError::InvalidEngine);
        }
        Ok(())
    }
}

/// Parse an all-disabled response and prove it matches the caller's enrolled binding and this build's engine schema.
/// Timestamp shape is checked, not credential freshness: future transport admission must re-prove current authority.
pub fn parse_disabled_connection(
    body: &str,
    expected: &ConnectionBinding,
) -> Result<DisabledConnection, ConnectionError> {
    let metadata = parse_disabled_metadata(body)?;
    metadata.check_binding(expected)?;
    Ok(metadata)
}

/// Validate only the separate metadata schema and all-disabled capabilities. This does not bind an enrolled profile.
pub fn parse_disabled_metadata(body: &str) -> Result<DisabledConnection, ConnectionError> {
    if body.len() > MAX_CONNECTION_METADATA_BYTES {
        return Err(ConnectionError::BodyTooLarge);
    }
    let metadata: Metadata =
        serde_json::from_str(body).map_err(|_| ConnectionError::MalformedMetadata)?;
    if metadata.protocol != CONNECTION_PROTOCOL {
        return Err(ConnectionError::UnsupportedProtocol);
    }
    let workspace = &metadata.workspace;
    if !uuid_v4(&workspace.id)
        || !lower_hex(&workspace.recovery_generation, 32)
        || !printable(&workspace.label)
    {
        return Err(ConnectionError::InvalidWorkspace);
    }
    let principal = &metadata.principal;
    if !printable(&principal.account) || !timestamp(&principal.expires_at) {
        return Err(ConnectionError::InvalidPrincipal);
    }
    if metadata.engine.version != API_VERSION || !lower_hex(&metadata.engine.contract, 64) {
        return Err(ConnectionError::InvalidEngine);
    }
    if !metadata.capabilities.disabled() {
        return Err(ConnectionError::CapabilitiesEnabled);
    }
    Ok(DisabledConnection(metadata))
}

fn lower_hex(s: &str, size: usize) -> bool {
    s.len() == size
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn uuid_v4(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            14 => b == b'4',
            19 => matches!(b, b'8' | b'9' | b'a' | b'b'),
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

fn printable(s: &str) -> bool {
    !s.is_empty()
        && s.chars().count() <= 200
        && !s.chars().any(|c| {
            c.is_control()
                || matches!(c, '\u{061c}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}'
            | '\u{2060}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
        })
}

/// Canonical UTC timestamp emitted by Date.toISOString(), with a real Gregorian date and no offset/leap second.
fn timestamp(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 24
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[19] != b'.'
        || b[23] != b'Z'
        || !b
            .iter()
            .enumerate()
            .all(|(i, x)| [4, 7, 10, 13, 16, 19, 23].contains(&i) || x.is_ascii_digit())
    {
        return false;
    }
    let number = |a: usize, z: usize| {
        b[a..z]
            .iter()
            .fold(0_u32, |n, d| n * 10 + u32::from(d - b'0'))
    };
    let year = number(0, 4);
    let month = number(5, 7);
    let day = number(8, 10);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    day >= 1 && day <= days && number(11, 13) <= 23 && number(14, 16) <= 59 && number(17, 19) <= 59
}
