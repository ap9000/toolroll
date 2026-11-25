//! Every fixture in test/fixtures/engine-api/ (the ones the TypeScript contract test parses too) parses as its model
//! here and serialises back to exactly the same JSON: the two sides hold the same shapes, keys and all.
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use toolroll_api::*;

const DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../test/fixtures/engine-api/"
);

fn read(name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(format!("{DIR}{name}")).unwrap()).unwrap()
}

fn round_trip<T: DeserializeOwned + Serialize>(name: &str) -> T {
    let raw = read(name);
    let parsed: T = serde_json::from_value(raw.clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
    assert_eq!(
        serde_json::to_value(&parsed).unwrap(),
        raw,
        "{name} changed on a round trip"
    );
    parsed
}

/// Each fixture file and the response it is (src/contracts/engine-api.test.ts FIXTURES).
const FIXTURES: &[(&str, &str)] = &[
    ("live-session-window.json", "liveSessionWindow"),
    ("live-session-window-sub-missing.json", "liveSessionWindow"),
    ("live-session-window-thread.json", "liveSessionWindow"),
    ("live-threads.json", "liveThreads"),
    ("work-rows.json", "workRows"),
    ("work-rows-every-kind.json", "workRows"),
    ("step-cards-just-code.json", "stepCards"),
    ("step-cards-plan-first.json", "stepCards"),
    ("step-cards-sent-back.json", "stepCards"),
    ("step-cards-plan-stopped.json", "stepCards"),
    ("approval-card.json", "approvalCard"),
    ("approval-card-problem.json", "approvalCard"),
    ("result-diff.json", "resultDiff"),
    ("result-diff-no-result.json", "resultDiff"),
    ("result-diff-file.json", "resultDiffFile"),
    ("result-diff-context.json", "resultDiffContext"),
    ("task-result.json", "taskResult"),
    ("link-redemption.json", "linkRedemption"),
    ("refusal.json", "refusal"),
    ("hello.json", "hello"),
    ("agents.json", "agents"),
    ("agents-none-signed-in.json", "agents"),
    ("models.json", "models"),
    ("lead-chat.json", "leadChat"),
    ("term-state.json", "termState"),
    ("term-started.json", "termStarted"),
    ("term-start-refused.json", "termStarted"),
    ("automations.json", "automations"),
    ("automations-every-kind.json", "automations"),
    ("projects.json", "projects"),
    ("direct-chats-list.json", "directChatsList"),
    ("direct-chat-detail.json", "directChatDetail"),
    ("direct-chat-started.json", "directChatStarted"),
    ("direct-chat-start-refused.json", "directChatStarted"),
    ("direct-chat-mutated.json", "directChatMutated"),
    ("direct-chat-mutate-refused.json", "directChatMutated"),
    ("direct-chat-ship-preview.json", "directChatShipPreview"),
    ("direct-chat-shipped.json", "directChatShipped"),
    ("direct-chat-ship-refused.json", "directChatShipped"),
    ("direct-chat-attached.json", "directChatAttached"),
    ("direct-chat-attach-refused.json", "directChatAttached"),
];

#[test]
fn every_fixture_is_named_and_every_response_has_a_model() {
    let mut files: Vec<String> = std::fs::read_dir(DIR)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n.ends_with(".json") && n != "schemas.json")
        .collect();
    files.sort();
    let mut named: Vec<String> = FIXTURES.iter().map(|(f, _)| f.to_string()).collect();
    named.sort();
    assert_eq!(
        files, named,
        "a fixture without a model test (or the reverse)"
    );
    let schemas = read("schemas.json");
    let mut responses: Vec<String> = schemas["responses"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    responses.sort();
    let mut modelled: Vec<String> = FIXTURES.iter().map(|(_, r)| r.to_string()).collect();
    modelled.sort();
    modelled.dedup();
    assert_eq!(
        responses, modelled,
        "a response in the contract this client has no model for"
    );
}

#[test]
fn every_fixture_round_trips_exactly() {
    for (name, response) in FIXTURES {
        match *response {
            "liveSessionWindow" => drop(round_trip::<LiveSessionWindow>(name)),
            "liveThreads" => drop(round_trip::<LiveThreads>(name)),
            "workRows" => drop(round_trip::<WorkRows>(name)),
            "stepCards" => drop(round_trip::<StepCards>(name)),
            "approvalCard" => drop(round_trip::<ApprovalCard>(name)),
            "resultDiff" => drop(round_trip::<ResultDiff>(name)),
            "resultDiffContext" => drop(round_trip::<ResultDiffContext>(name)),
            "resultDiffFile" => drop(round_trip::<ResultDiffFile>(name)),
            "taskResult" => drop(round_trip::<TaskResult>(name)),
            "linkRedemption" => drop(round_trip::<LinkRedemption>(name)),
            "refusal" => drop(round_trip::<Refusal>(name)),
            "hello" => drop(round_trip::<Hello>(name)),
            "agents" => drop(round_trip::<AgentsRead>(name)),
            "models" => drop(round_trip::<ModelsRead>(name)),
            "leadChat" => drop(round_trip::<LeadChat>(name)),
            "termState" => drop(round_trip::<TermState>(name)),
            "termStarted" => drop(round_trip::<TermStarted>(name)),
            "automations" => drop(round_trip::<AutomationsRead>(name)),
            "projects" => drop(round_trip::<ProjectsRead>(name)),
            "directChatsList" => drop(round_trip::<DirectChatsList>(name)),
            "directChatDetail" => drop(round_trip::<DirectChatDetail>(name)),
            "directChatStarted" => drop(round_trip::<DirectChatStarted>(name)),
            "directChatMutated" => drop(round_trip::<DirectChatMutated>(name)),
            "directChatShipPreview" => drop(round_trip::<DirectChatShipPreview>(name)),
            "directChatShipped" => drop(round_trip::<DirectChatShipped>(name)),
            "directChatAttached" => drop(round_trip::<DirectChatAttached>(name)),
            other => panic!("no model for {other}"),
        }
    }
}

#[test]
fn every_property_the_contract_names_is_modelled() {
    // For each response's JSON Schema: every object's property names, and the same object's keys in a maximal
    // instance built from the model — a property the contract added that this client doesn't know fails here.
    let schemas = read("schemas.json");
    for (name, response) in FIXTURES {
        let schema = &schemas["responses"][*response];
        let fixture = read(name);
        check_props(schema, &fixture, response);
    }
}

/// Every property a schema names that the instance has an object for: the instance's keys are a subset of the schema's
/// and the schema's required keys are all present (so the model, which round-trips the instance, carries them).
fn check_props(schema: &Value, value: &Value, path: &str) {
    if let Some(any) = schema["anyOf"]
        .as_array()
        .or_else(|| schema["oneOf"].as_array())
    {
        // The branch the instance matches by its required keys and constants.
        for branch in any {
            if matches_branch(branch, value) {
                return check_props(branch, value, path);
            }
        }
        panic!("{path} matches no shape the contract allows");
    }
    match value {
        Value::Object(map) => {
            let Some(props) = schema["properties"].as_object() else {
                return;
            };
            for key in map.keys() {
                assert!(
                    props.contains_key(key),
                    "{path}.{key} is not in the contract"
                );
            }
            for req in schema["required"].as_array().into_iter().flatten() {
                assert!(
                    map.contains_key(req.as_str().unwrap()),
                    "{path}.{} is required by the contract",
                    req
                );
            }
            for (key, child) in map {
                check_props(&props[key], child, &format!("{path}.{key}"));
            }
        }
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                check_props(&schema["items"], item, &format!("{path}[{i}]"));
            }
        }
        _ => {}
    }
}

fn matches_branch(branch: &Value, value: &Value) -> bool {
    if let Some(any) = branch["anyOf"]
        .as_array()
        .or_else(|| branch["oneOf"].as_array())
    {
        return any.iter().any(|sub| matches_branch(sub, value));
    }
    match value {
        Value::Object(map) => {
            let Some(props) = branch["properties"].as_object() else {
                return false;
            };
            let required_ok = branch["required"]
                .as_array()
                .into_iter()
                .flatten()
                .all(|r| map.contains_key(r.as_str().unwrap()));
            let keys_ok = map.keys().all(|k| props.contains_key(k));
            let consts_ok = props.iter().all(|(k, p)| {
                p.get("const")
                    .is_none_or(|c| map.get(k).is_none_or(|v| v == c))
            });
            required_ok && keys_ok && consts_ok
        }
        Value::Null => branch["type"] == "null",
        Value::Array(_) => branch["type"] == "array",
        Value::String(_) => branch["type"] == "string",
        Value::Bool(_) => branch["type"] == "boolean",
        Value::Number(_) => branch["type"] == "number" || branch["type"] == "integer",
    }
}

#[test]
fn this_build_knows_the_contract_digest() {
    let digest = contract_digest();
    assert_eq!(digest.len(), 64);
    assert_eq!(digest, read("schemas.json")["digest"].as_str().unwrap());
    let hello: Hello = serde_json::from_value(read("hello.json")).unwrap();
    // The fixture's handshake is from the engine that wrote the fixtures.
    assert_eq!(
        check_hello(&Hello {
            contract: digest.clone(),
            ..hello.clone()
        }),
        Ok(())
    );
    assert!(check_hello(&Hello {
        contract: "0".repeat(64),
        ..hello.clone()
    })
    .unwrap_err()
    .contains("another Toolroll version"));
    assert!(check_hello(&Hello {
        version: 2,
        contract: digest,
        ..hello
    })
    .is_err());
}

#[test]
fn a_redemption_prints_no_secret() {
    let r: LinkRedemption = serde_json::from_value(read("link-redemption.json")).unwrap();
    let shown = format!("{r:?}");
    assert!(
        !shown.contains(&r.cookie.value) && !shown.contains(&r.csrf) && !shown.contains(&r.key)
    );
}

#[test]
fn a_key_the_contract_does_not_name_is_caught() {
    let schemas = read("schemas.json");
    let mut rows = read("work-rows.json");
    rows["rows"][0]["need"]["surprise"] = Value::Bool(true);
    let caught = std::panic::catch_unwind(|| {
        check_props(&schemas["responses"]["workRows"], &rows, "workRows")
    });
    assert!(caught.is_err());
    // And the model refuses it too (strict objects).
    assert!(serde_json::from_value::<WorkRows>(rows).is_err());
}

#[test]
fn attach_facts_are_optional_and_unknown_terminal_fields_are_refused() {
    let mut legacy = read("live-session-window-thread.json");
    let thread = legacy["thread"].as_object_mut().unwrap();
    thread.remove("runtime");
    thread.remove("terminal");
    let parsed: LiveSessionWindow = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), legacy);

    let mut modern = read("live-session-window-thread.json");
    modern["thread"]["runtime"] = Value::String("interactive".into());
    assert!(serde_json::from_value::<LiveSessionWindow>(modern.clone()).is_ok());
    modern["thread"]["terminal"]["executable"] = Value::String("claude".into());
    assert!(serde_json::from_value::<LiveSessionWindow>(modern).is_err());
}
