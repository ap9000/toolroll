//! Separate disabled connection protocol and enrolled identity guards; no remote transport or agent process.
use serde::Deserialize;
use serde_json::{json, Value};
use toolroll_api::{
    contract_digest, parse_connection_refusal, parse_disabled_connection, parse_disabled_metadata,
    ConnectionAccess, ConnectionBinding, ConnectionError, ConnectionRefusal, ConnectionRole,
    MAX_CONNECTION_METADATA_BYTES,
};

const WORKSPACE: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RECOVERY: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CASES: &str = include_str!("../../../../test/fixtures/terminal-connection/cases.json");

#[derive(Deserialize)]
struct Case {
    name: String,
    valid: bool,
    value: Value,
}

fn fixture() -> Value {
    let cases: Vec<Case> = serde_json::from_str(CASES).unwrap();
    let mut value = cases
        .into_iter()
        .find(|c| c.name == "read-token-scaffold")
        .unwrap()
        .value;
    value["engine"]["contract"] = json!(contract_digest());
    value
}

fn binding() -> ConnectionBinding {
    ConnectionBinding::new(WORKSPACE, RECOVERY, "alice").unwrap()
}

fn bound(value: &Value) -> Result<toolroll_api::DisabledConnection, ConnectionError> {
    parse_disabled_connection(&value.to_string(), &binding())
}

#[test]
fn matches_shared_schema_cases_and_round_trips_without_silently_dropping_fields() {
    let cases: Vec<Case> = serde_json::from_str(CASES).unwrap();
    assert!(cases.len() >= 17);
    for case in cases {
        let result = parse_disabled_metadata(&case.value.to_string());
        assert_eq!(result.is_ok(), case.valid, "{}: {result:?}", case.name);
        if let Ok(metadata) = result {
            assert_eq!(
                serde_json::to_value(metadata).unwrap(),
                case.value,
                "{}",
                case.name
            );
        }
    }
}

#[test]
fn scaffold_identity_is_bound_but_no_capabilities_are_enabled_even_for_an_act_token() {
    let mut value = fixture();
    for (role, access) in [
        ("viewer", "read"),
        ("approver", "read"),
        ("approver", "act"),
    ] {
        value["principal"]["role"] = json!(role);
        value["principal"]["access"] = json!(access);
        let metadata = bound(&value).unwrap();
        assert_eq!(metadata.workspace_id(), WORKSPACE);
        assert_eq!(metadata.recovery_generation(), RECOVERY);
        assert_eq!(metadata.account(), "alice");
        assert_eq!(metadata.label(), "Toolroll");
        assert_eq!(metadata.expires_at(), "2026-12-20T00:00:00.000Z");
        assert_eq!(
            metadata.role(),
            if role == "viewer" {
                ConnectionRole::Viewer
            } else {
                ConnectionRole::Approver
            }
        );
        assert_eq!(
            metadata.access(),
            if access == "read" {
                ConnectionAccess::Read
            } else {
                ConnectionAccess::Act
            }
        );
        assert_eq!(serde_json::to_value(metadata).unwrap(), value);
    }
}

#[test]
fn never_replaces_enrolled_workspace_recovery_account_or_engine_from_response_values() {
    for (section, field, wrong, expected) in [
        (
            "workspace",
            "id",
            "dddddddd-dddd-4ddd-9ddd-dddddddddddd",
            ConnectionError::WorkspaceMismatch,
        ),
        (
            "workspace",
            "recoveryGeneration",
            "dddddddddddddddddddddddddddddddd",
            ConnectionError::RecoveryChanged,
        ),
        (
            "principal",
            "account",
            "bob",
            ConnectionError::AccountMismatch,
        ),
        (
            "engine",
            "contract",
            "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            ConnectionError::InvalidEngine,
        ),
    ] {
        let mut value = fixture();
        value[section][field] = json!(wrong);
        assert_eq!(bound(&value).unwrap_err(), expected, "{section}.{field}");
        // Each replacement is structurally valid; only the separate trusted binding comparison refuses it.
        assert!(parse_disabled_metadata(&value.to_string()).is_ok());
    }
}

#[test]
fn every_capability_must_stay_false_and_commands_empty() {
    for field in [
        "workRows",
        "stepCards",
        "resultDiff",
        "runLiveWindow",
        "providerSetup",
        "localCode",
        "localExecution",
        "interactive",
    ] {
        let mut value = fixture();
        value["capabilities"][field] = json!(true);
        assert_eq!(
            bound(&value).unwrap_err(),
            ConnectionError::CapabilitiesEnabled,
            "{field}"
        );
    }
    for commands in [json!(["task add"]), json!(["approve"]), json!(["unknown"])] {
        let mut value = fixture();
        value["capabilities"]["commands"] = commands;
        assert_eq!(
            bound(&value).unwrap_err(),
            ConnectionError::CapabilitiesEnabled
        );
    }
    let mut value = fixture();
    value["capabilities"]["approval"] = json!("terminal");
    assert_eq!(
        bound(&value).unwrap_err(),
        ConnectionError::MalformedMetadata
    );
}

#[test]
fn rejects_unknown_fields_at_every_level_duplicate_fields_missing_fields_and_wrong_types() {
    for path in ["", "/workspace", "/principal", "/engine", "/capabilities"] {
        let mut value = fixture();
        value
            .pointer_mut(path)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("token".into(), json!("so_SECRET_SENTINEL"));
        let error = bound(&value).unwrap_err();
        assert_eq!(error, ConnectionError::MalformedMetadata);
        assert!(!format!("{error:?}: {error}").contains("SECRET_SENTINEL"));
        let value = fixture();
        let fields: Vec<_> = value
            .pointer(path)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        for field in fields {
            let mut value = fixture();
            value
                .pointer_mut(path)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(&field);
            assert_eq!(
                bound(&value).unwrap_err(),
                ConnectionError::MalformedMetadata,
                "{path}/{field}"
            );
        }
    }
    let raw = fixture().to_string();
    for duplicate in [
        raw.replace("\"protocol\":1", "\"protocol\":1,\"protocol\":1"),
        raw.replace(
            "\"account\":\"alice\"",
            "\"account\":\"alice\",\"account\":\"alice\"",
        ),
    ] {
        assert_eq!(
            parse_disabled_connection(&duplicate, &binding()).unwrap_err(),
            ConnectionError::MalformedMetadata
        );
    }
    for value in [
        json!(null),
        json!([]),
        json!("so_SECRET_SENTINEL"),
        json!({"protocol":1}),
    ] {
        assert_eq!(
            bound(&value).unwrap_err(),
            ConnectionError::MalformedMetadata
        );
    }
    for (path, wrong) in [
        ("/protocol", json!(1.5)),
        ("/engine/version", json!("1")),
        ("/capabilities/workRows", json!(0)),
        ("/capabilities/commands", json!([1])),
        ("/principal/role", json!("owner")),
        ("/principal/access", json!("write")),
    ] {
        let mut value = fixture();
        *value.pointer_mut(path).unwrap() = wrong;
        assert_eq!(
            bound(&value).unwrap_err(),
            ConnectionError::MalformedMetadata,
            "{path}"
        );
    }
}

#[test]
fn rejects_malformed_identity_version_and_digest() {
    for id in [
        "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        "aaaaaaaa-aaaa-3aaa-8aaa-aaaaaaaaaaaa",
        "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa",
        "../workspace",
        "",
    ] {
        let mut value = fixture();
        value["workspace"]["id"] = json!(id);
        assert_eq!(
            bound(&value).unwrap_err(),
            ConnectionError::InvalidWorkspace
        );
        assert_eq!(
            ConnectionBinding::new(id, RECOVERY, "alice").unwrap_err(),
            ConnectionError::InvalidBinding
        );
    }
    for generation in ["B".repeat(32), "b".repeat(31), "g".repeat(32)] {
        let mut value = fixture();
        value["workspace"]["recoveryGeneration"] = json!(generation);
        assert_eq!(
            bound(&value).unwrap_err(),
            ConnectionError::InvalidWorkspace
        );
    }
    for digest in ["C".repeat(64), "c".repeat(63), "g".repeat(64)] {
        let mut value = fixture();
        value["engine"]["contract"] = json!(digest);
        assert_eq!(bound(&value).unwrap_err(), ConnectionError::InvalidEngine);
    }
    let mut value = fixture();
    value["engine"]["version"] = json!(2);
    assert_eq!(bound(&value).unwrap_err(), ConnectionError::InvalidEngine);
    value = fixture();
    value["protocol"] = json!(2);
    assert_eq!(
        bound(&value).unwrap_err(),
        ConnectionError::UnsupportedProtocol
    );
}

#[test]
fn printable_identity_uses_unicode_scalar_bounds_and_rejects_hidden_controls() {
    for field in ["account", "label"] {
        let section = if field == "account" {
            "principal"
        } else {
            "workspace"
        };
        for text in ["é".repeat(200), "🦀".repeat(200), "alice 日本語".into()] {
            let mut value = fixture();
            value[section][field] = json!(text);
            assert!(parse_disabled_metadata(&value.to_string()).is_ok());
        }
        for text in ["".into(), "a".repeat(201), "🦀".repeat(201)] {
            let mut value = fixture();
            value[section][field] = json!(text);
            assert!(parse_disabled_metadata(&value.to_string()).is_err());
        }
        for c in [
            '\0', '\n', '\u{007f}', '\u{009f}', '\u{061c}', '\u{200b}', '\u{200c}', '\u{200d}',
            '\u{200e}', '\u{200f}', '\u{202a}', '\u{202e}', '\u{2060}', '\u{2066}', '\u{2069}',
            '\u{feff}',
        ] {
            let mut value = fixture();
            value[section][field] = json!(format!("alice{c}"));
            assert!(
                parse_disabled_metadata(&value.to_string()).is_err(),
                "{field}: U+{:04x}",
                c as u32
            );
        }
    }
    let raw = fixture().to_string().replace("\"alice\"", "\"\\ud800\"");
    assert_eq!(
        parse_disabled_metadata(&raw).unwrap_err(),
        ConnectionError::MalformedMetadata
    );
}

#[test]
fn expiry_is_a_real_canonical_utc_millisecond_timestamp_not_a_freshness_proof() {
    for date in [
        "2000-02-29T23:59:59.999Z",
        "0000-02-29T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
    ] {
        let mut value = fixture();
        value["principal"]["expiresAt"] = json!(date);
        assert!(bound(&value).is_ok());
    }
    for date in [
        "1900-02-29T00:00:00.000Z",
        "2026-02-29T00:00:00.000Z",
        "2026-04-31T00:00:00.000Z",
        "2026-00-01T00:00:00.000Z",
        "2026-01-00T00:00:00.000Z",
        "2026-13-01T00:00:00.000Z",
        "2026-12-20T24:00:00.000Z",
        "2026-12-20T00:60:00.000Z",
        "2026-12-20T00:00:60.000Z",
        "2026-12-20T00:00:00Z",
        "2026-12-20T00:00:00.000+00:00",
        "2026-12-20T00:00:00.000z",
        "",
    ] {
        let mut value = fixture();
        value["principal"]["expiresAt"] = json!(date);
        assert_eq!(
            bound(&value).unwrap_err(),
            ConnectionError::InvalidPrincipal,
            "{date}"
        );
    }
    let mut value = fixture();
    value["principal"]["expiresAt"] = Value::Null;
    assert_eq!(
        bound(&value).unwrap_err(),
        ConnectionError::MalformedMetadata
    );
}

#[test]
fn refusal_contract_is_closed_and_never_echoes_unknown_server_payloads() {
    for (code, expected) in [
        ("request", ConnectionRefusal::Request),
        ("unauthenticated", ConnectionRefusal::Unauthenticated),
        ("credential-purpose", ConnectionRefusal::CredentialPurpose),
        (
            "workspace-unavailable",
            ConnectionRefusal::WorkspaceUnavailable,
        ),
        (
            "contract-unavailable",
            ConnectionRefusal::ContractUnavailable,
        ),
    ] {
        assert_eq!(
            parse_connection_refusal(&json!({"protocol":1,"error":code}).to_string()).unwrap(),
            expected
        );
    }
    for value in [
        json!({"protocol":1,"error":"so_SECRET_SENTINEL"}),
        json!({"protocol":1,"error":"request","token":"so_SECRET_SENTINEL"}),
        json!({"protocol":1}),
        json!({"error":"request"}),
    ] {
        let error = parse_connection_refusal(&value.to_string()).unwrap_err();
        assert!(!format!("{error:?} {error}").contains("SECRET_SENTINEL"));
    }
    assert_eq!(
        parse_connection_refusal(r#"{"protocol":2,"error":"request"}"#).unwrap_err(),
        ConnectionError::UnsupportedProtocol
    );
    assert_eq!(
        parse_connection_refusal(r#"{"protocol":1,"protocol":1,"error":"request"}"#).unwrap_err(),
        ConnectionError::MalformedMetadata
    );
}

#[test]
fn bounded_parsing_and_debug_never_disclose_identity_or_payload() {
    let huge = format!("{}{}", fixture(), " ".repeat(MAX_CONNECTION_METADATA_BYTES));
    assert_eq!(
        parse_disabled_metadata(&huge).unwrap_err(),
        ConnectionError::BodyTooLarge
    );
    assert_eq!(
        parse_connection_refusal(&huge).unwrap_err(),
        ConnectionError::BodyTooLarge
    );
    let debug = format!("{:?} {:?}", binding(), bound(&fixture()).unwrap());
    for private in [WORKSPACE, RECOVERY, "alice", "Toolroll"] {
        assert!(!debug.contains(private));
    }
}
