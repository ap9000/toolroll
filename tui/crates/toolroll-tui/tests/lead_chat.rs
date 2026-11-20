//! End-to-end and behavioral tests for Central Lead Chat + Peekable Task Inspector (Slices 1, 2 & 3):
//! - Slice 1: `GET /engine/chat`, `POST /chat`, `POST /chat/proposal/<id>/(confirm|dismiss)`, `POST /chat/queued/<id>/remove`, and SSE `event: turn`
//! - Slice 2: Pinned `Lead` rail entry, structured `ChatCard` blocks, collapsible tool steps, live `LiveTurn` streaming, composer, and `seen_end`/irreversible proposal confirmation gate
//! - Slice 3: Docked `Work rail | Central Lead Chat | Peeked Task` layout, task-link peeking into `Diff`, and responsive degradation across wide/normal/narrow viewports
#[path = "common/pairs.rs"]
mod pairs;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use toolroll_api::{
    ChatSendOutcome, LeadCardPrimary, LeadChat, LiveSignal, LiveTurn, LiveTurnStep, LiveTurnTool,
    ProposalActOutcome,
};
use toolroll_fake_engine as fake;
use toolroll_tui::app::{App, Effect, Focus, Mode, Msg, Tab};
use toolroll_tui::chat::{ChatFocus, ChatHit};
use toolroll_tui::theme::{Depth, Glyphs, Theme, ThemeName};

const NOW: i64 = 1_794_657_852;

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).expect("fixture shape")
}
fn key(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
}
fn code(c: KeyCode) -> KeyEvent {
    KeyEvent::new(c, KeyModifiers::NONE)
}

fn answer(app: &mut App, fx: Vec<Effect>) {
    let state = fake::scenario();
    let mut todo = fx;
    for _ in 0..8 {
        let mut next = vec![];
        for e in todo.drain(..) {
            match e {
                Effect::FetchLeadChat => {
                    next.extend(app.update(Msg::LeadChat(Ok(parse(state.lead_chat.clone())))));
                }
                Effect::FetchSteps(task) => {
                    if let Some(steps) = state.steps.get(&task) {
                        next.extend(app.update(Msg::Steps(task, Ok(parse(steps.clone())))));
                    }
                }
                Effect::FetchDiff(ask) => {
                    if let Some(diff) = state.diffs.get(&ask.task) {
                        next.extend(app.update(Msg::Diff(ask, Ok(parse(diff.clone())))));
                    }
                }
                Effect::FetchDiffFile(ask) => {
                    let k = format!("{}:{}", ask.task, ask.file);
                    if let Some(f) = state.diff_files.get(&k) {
                        next.extend(app.update(Msg::DiffFile(ask, Ok(parse(f.clone())))));
                    }
                }
                _ => {}
            }
        }
        if next.is_empty() {
            break;
        }
        todo = next;
    }
}

fn loaded_app() -> App {
    let mut app = App::new(true, Some("/home/me/shop".into()));
    app.now = NOW;
    let fx = app.update(Msg::Work(Ok(parse(fake::scenario_work()))));
    answer(&mut app, fx);
    let fx = app.update(Msg::LeadChat(Ok(parse(fake::scenario_lead_chat()))));
    answer(&mut app, fx);
    app
}

fn render(app: &mut App, w: u16, h: u16) -> String {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| toolroll_tui::view::draw(f, app)).unwrap();
    let buf = term.backend().buffer().clone();
    let mut out = String::new();
    for y in 0..h {
        let mut line = String::new();
        for x in 0..w {
            line.push_str(buf[(x, y)].symbol());
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

#[test]
fn lead_chat_renders_pinned_rail_cards_and_passes_drawn_pairs_contrast() {
    let mut app = loaded_app();
    // Press C to open Central Lead chat
    let fx = app.key(key('C'));
    answer(&mut app, fx);
    assert!(app.chat_open);
    assert!(app.chat_focused());

    // Scroll to top to verify full card blocks, then bottom for proposals + composer
    app.chat.follow = false;
    app.chat.scroll = 0;
    let top_screen = render(&mut app, 120, 42);
    assert!(top_screen.contains("Lead · central chat"), "{top_screen}");
    assert!(top_screen.contains("Fleet status"), "{top_screen}");
    assert!(top_screen.contains("Lead note:"), "{top_screen}");
    assert!(top_screen.contains("Fix checkout total"), "{top_screen}");
    assert!(
        top_screen.contains("All 14 checkout tests passed."),
        "{top_screen}"
    );
    assert!(
        top_screen.contains("Inspect CSV export diff"),
        "{top_screen}"
    );

    app.chat.follow_end();
    let bottom_screen = render(&mut app, 120, 42);
    assert!(bottom_screen.contains("New task"), "{bottom_screen}");
    assert!(
        bottom_screen.contains("Add coupon edge-case tests"),
        "{bottom_screen}"
    );
    assert!(bottom_screen.contains("Queued:"), "{bottom_screen}");
    assert!(bottom_screen.contains("Message Lead"), "{bottom_screen}");
    assert!(
        bottom_screen.contains("Ask Lead anything across all projects"),
        "{bottom_screen}"
    );

    // Receiving `state: "idle"` from `/live?room=chat` must NEVER show "Thinking…" or busy state!
    let fx = app.update(Msg::Signal(LiveSignal::Turn {
        room: "chat".into(),
        turn: LiveTurn {
            state: Some("idle".into()),
            steps: vec![],
            phase: String::new(),
            status: String::new(),
            text: String::new(),
            done: false,
            ok: false,
        },
    }));
    assert!(fx.is_empty());
    assert!(!app.chat.is_busy());
    let idle_screen = render(&mut app, 120, 42);
    assert!(
        !idle_screen.contains("Thinking…"),
        "idle turn must not show Thinking:\n{idle_screen}"
    );

    // Every cell drawn across Light, Dark, HighContrast and ASCII fallback obeys theme::DRAWN_PAIRS.
    app.chat_docked = true;
    for theme_name in [ThemeName::Light, ThemeName::Dark, ThemeName::HighContrast] {
        app.prefs.theme = Theme::build(theme_name, Depth::TrueColor, None, &[]).0;
        app.prefs.settings.glyphs = Glyphs::Unicode;
        let _ = pairs::check(&mut app, 160, 40);
    }
    app.prefs.settings.glyphs = Glyphs::Ascii;
    let ascii = render(&mut app, 120, 32);
    assert!(ascii.is_ascii(), "ASCII mode emitted non-ASCII:\n{ascii}");
}

#[test]
fn live_turn_streams_status_collapsible_tools_and_partial_text() {
    let mut app = loaded_app();
    let fx = app.key(key('C'));
    answer(&mut app, fx);

    let turn = LiveTurn {
        state: None,
        steps: vec![LiveTurnStep {
            tools: vec!["read tasks".into(), "inspect diff".into()],
            tool_calls: vec![
                LiveTurnTool {
                    id: "t1".into(),
                    label: "read tasks".into(),
                    state: "ok".into(),
                    summary: Some("5 tasks".into()),
                },
                LiveTurnTool {
                    id: "t2".into(),
                    label: "inspect diff".into(),
                    state: "running".into(),
                    summary: None,
                },
            ],
        }],
        phase: "writing".into(),
        status: "Writing…".into(),
        text: "Reviewing t-done now before filing a follow-up.".into(),
        done: false,
        ok: false,
    };
    let fx = app.update(Msg::Signal(LiveSignal::Turn {
        room: "chat".into(),
        turn,
    }));
    assert!(
        fx.is_empty(),
        "in-progress turn does not refetch whole chat yet"
    );

    let collapsed = render(&mut app, 120, 36);
    assert!(collapsed.contains("Writing…"), "{collapsed}");
    assert!(collapsed.contains("2 tool steps"), "{collapsed}");
    assert!(collapsed.contains("Reviewing t-done now"), "{collapsed}");
    assert!(
        !collapsed.contains("5 tasks"),
        "tools start collapsed:\n{collapsed}"
    );

    // Press Esc to exit chatbox typing into browse mode, then `e` to expand tool steps
    app.key(code(KeyCode::Esc));
    app.key(key('e'));
    let expanded = render(&mut app, 120, 36);
    assert!(expanded.contains("read tasks · 5 tasks"), "{expanded}");
    assert!(expanded.contains("inspect diff"), "{expanded}");

    // Final `done: true` frame triggers a fresh GET /engine/chat sync
    let fx = app.update(Msg::Signal(LiveSignal::Turn {
        room: "chat".into(),
        turn: LiveTurn {
            state: None,
            steps: vec![],
            phase: "done".into(),
            status: String::new(),
            text: String::new(),
            done: true,
            ok: true,
        },
    }));
    assert!(
        fx.iter().any(|e| matches!(e, Effect::FetchLeadChat)),
        "completed turn refetches Lead chat: {fx:?}"
    );
}

#[test]
fn proposal_confirmation_requires_drawn_dialog_seen_end_and_irreversible_arming() {
    let mut app = loaded_app();
    // Mark proposal #102 as irreversible to verify explicit arming safety gate.
    if let Some(chat) = app.chat.data.as_mut() {
        for m in &mut chat.messages {
            for c in &mut m.cards {
                if c.id == 102 {
                    if let Some(LeadCardPrimary::Confirm { irreversible, .. }) = &mut c.primary {
                        *irreversible = true;
                    }
                }
            }
        }
    }
    app.chat.rebuild_items(true);
    let fx = app.key(key('C'));
    answer(&mut app, fx);
    let _ = render(&mut app, 120, 34);

    // Enter in an empty field does nothing. Leave the composer to act on the transcript.
    assert!(app.key(code(KeyCode::Enter)).is_empty());
    assert!(matches!(app.mode, Mode::ChatCompose(_)));
    app.key(code(KeyCode::Esc));
    assert_eq!(app.chat.current_hit(), Some(&ChatHit::ConfirmProposal(102)));
    let fx = app.key(code(KeyCode::Enter));
    assert!(
        fx.is_empty(),
        "Enter opens confirm dialog, never sends directly"
    );
    assert!(matches!(app.mode, Mode::ConfirmProposal(_)));

    // Before drawing the dialog, Enter is refused (UNDRAWN).
    let fx = app.key(code(KeyCode::Enter));
    assert!(fx.is_empty());

    // Draw the dialog: seen_end becomes true, but irreversible is not yet armed.
    let dialog_screen = render(&mut app, 120, 34);
    assert!(
        dialog_screen.contains("Confirm exactly this proposal"),
        "{dialog_screen}"
    );
    assert!(
        dialog_screen.contains("I understand this cannot be undone"),
        "{dialog_screen}"
    );

    // Pressing Enter before arming refuses and emits nothing.
    let fx = app.key(code(KeyCode::Enter));
    assert!(fx.is_empty());
    assert!(matches!(app.mode, Mode::ConfirmProposal(_)));

    // Arm with `a`, redraw so drawn_dialog matches armed state, then Enter emits ProposalAct with confirm_yes = true.
    app.key(key('a'));
    let armed_screen = render(&mut app, 120, 34);
    assert!(
        armed_screen.contains("[x] I understand this cannot be undone"),
        "{armed_screen}"
    );
    let fx = app.key(code(KeyCode::Enter));
    assert_eq!(
        fx,
        vec![Effect::ProposalAct {
            id: 102,
            op: "confirm",
            confirm_yes: true,
        }]
    );
}

#[test]
fn composer_sends_and_dismiss_acts_cleanly() {
    let mut app = loaded_app();
    // Opening Lead chat immediately focuses the chatbox so typing works right away!
    let fx = app.key(key('C'));
    answer(&mut app, fx);
    assert!(matches!(app.mode, Mode::ChatCompose(_)));
    let _ = render(&mut app, 120, 34);

    // Typing directly sends on Enter and stays in the chatbox ready for follow-ups.
    for ch in "Check tests".chars() {
        app.key(key(ch));
    }
    let fx = app.key(code(KeyCode::Enter));
    assert!(matches!(app.mode, Mode::ChatCompose(ref s) if s.is_empty()));
    assert_eq!(app.chat.optimistic_sent.as_deref(), Some("Check tests"));
    assert!(
        fx.iter().any(|e| matches!(
            e,
            Effect::ChatSend { message, request, session: Some(7), .. }
            if message == "Check tests" && request.len() == 32
        )),
        "expected ChatSend effect: {fx:?}"
    );

    // Esc leaves typing mode to browse; `x` dismisses the selected pending proposal.
    app.key(code(KeyCode::Esc));
    assert_eq!(app.mode, Mode::Normal);
    let fx = app.key(key('x'));
    assert_eq!(
        fx,
        vec![Effect::ProposalAct {
            id: 102,
            op: "dismiss",
            confirm_yes: false,
        }]
    );
}

#[test]
fn slice_3_docked_chat_and_peek_inspector_with_task_link_jump() {
    let mut app = loaded_app();
    // Draw once at wide 160x40 so last_width is known, then press D to dock Lead chat beside task.
    let _ = render(&mut app, 160, 40);
    let fx = app.key(key('D'));
    answer(&mut app, fx);
    assert!(app.chat_docked);
    assert!(app.chat_split_active());

    let screen = render(&mut app, 160, 40);
    assert!(app.areas.chat_area.width > 40, "chat_area should be wide");
    assert!(app.areas.peek_area.width > 40, "peek_area should be wide");
    assert!(screen.contains("DOCKED"), "{screen}");
    assert!(
        screen.contains("Fix the login redirect"),
        "peek panel shows selected task:\n{screen}"
    );

    // Select the task link to `t-done` (Diff) inside the Lead card and activate it with Enter!
    let link_idx = app
        .chat
        .items
        .iter()
        .position(|h| matches!(h, ChatHit::PeekTask { task, tab: Some(t), .. } if task == "t-done" && t == "diff"))
        .expect("Lead card should expose t-done diff link");
    app.chat.selected_hit = link_idx;
    let fx = app.key(code(KeyCode::Enter));
    answer(&mut app, fx);

    assert_eq!(app.selected_item().map(|i| i.id.as_str()), Some("t-done"));
    assert_eq!(app.tab, Tab::Diff);
    // In docked mode, Lead Chat stays open right beside the Peeked Task and focus moves to Peek!
    assert!(app.chat_split_active());
    assert_eq!(app.chat_focus, ChatFocus::Peek);

    let peeked = render(&mut app, 160, 40);
    assert!(peeked.contains("Add CSV export"), "{peeked}");
    assert!(
        peeked.contains("Chat with Lead") || peeked.contains("Message Lead"),
        "{peeked}"
    );

    // `o` toggles focus smoothly back to Lead Chat!
    app.key(key('o'));
    assert_eq!(app.chat_focus, ChatFocus::Chat);
    assert!(app.chat_focused());

    // Clicking the pinned Lead row focuses Lead Chat even after moving back to the list.
    app.key(code(KeyCode::Esc));
    assert_eq!(app.effective_focus(), Focus::List);
    let _ = render(&mut app, 160, 40);
    let lr = app.areas.lead_row;
    assert!(lr.width > 0);
    app.mouse(MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: lr.x + 1,
        row: lr.y,
        modifiers: KeyModifiers::NONE,
    });
    assert!(app.chat_focused());

    // Narrow viewport degrades cleanly to single-column Lead chat, and Esc exits typing then returns to the task list.
    let narrow_chat = render(&mut app, 58, 26);
    assert!(!app.chat_split_active());
    assert!(narrow_chat.contains("Lead"), "{narrow_chat}");
    app.key(code(KeyCode::Esc));
    app.key(code(KeyCode::Esc));
    assert!(app.narrow_list);
}

#[tokio::test]
async fn end_to_end_fake_engine_chat_send_proposal_and_sse_turn() {
    let engine = fake::FakeEngine::start(fake::scenario(), 0).await;
    let client = toolroll_api::redeem(&engine.link()).await.expect("redeem");

    // 1. Read GET /engine/chat
    let initial: LeadChat = client.chat(None).await.expect("chat read");
    assert_eq!(initial.lead_name, "Lead");
    assert_eq!(initial.pending_proposals, 1);

    // 2. Subscribe to /live?room=chat and receive a live `event: turn` SSE snapshot
    let (tx, mut rx) = mpsc::unbounded_channel();
    let live_client = client.clone();
    let live_task = tokio::spawn(async move {
        let _ = live_client.live(&["chat".into()], tx).await;
    });
    // Wait on the real subscription fact (`/live` handler recorded the request) rather than a fixed sleep.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while engine
        .state
        .lock()
        .unwrap()
        .reads
        .get("/live")
        .copied()
        .unwrap_or(0)
        == 0
    {
        assert!(
            std::time::Instant::now() < deadline,
            "/live did not connect"
        );
        tokio::task::yield_now().await;
    }
    // Keep emitting until the broadcast subscriber has registered and received the turn snapshot.
    let sig = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            engine.emit_turn(
                "chat",
                json!({
                    "phase": "writing",
                    "status": "Writing…",
                    "text": "Live streaming reply",
                    "done": false,
                    "ok": false,
                    "steps": []
                }),
            );
            if let Ok(sig) = rx.try_recv() {
                return sig;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("sse timeout");
    match sig {
        LiveSignal::Turn { room, turn } => {
            assert_eq!(room, "chat");
            assert_eq!(turn.text, "Live streaming reply");
        }
        other => panic!("expected LiveSignal::Turn, got {other:?}"),
    }

    // 3. Send a message via POST /chat
    let sent = client
        .chat_send("Summarize builds", &"a".repeat(32), Some(7), None)
        .await
        .expect("chat_send");
    assert_eq!(
        sent,
        ChatSendOutcome::Accepted {
            session: 7,
            queued: false
        }
    );
    let after_send = client.chat(None).await.expect("chat after send");
    assert!(after_send
        .messages
        .iter()
        .any(|m| m.role == "operator" && m.text == "Summarize builds"));

    // 4. Confirm proposal #102 via POST /chat/proposal/102/confirm
    let acted = client
        .proposal_act(102, "confirm", false)
        .await
        .expect("proposal confirm");
    assert_eq!(
        acted,
        ProposalActOutcome::Done {
            said: "Filed task t-new.".into(),
            task_id: Some("t-new".into()),
        }
    );
    let after_confirm = client.chat(None).await.expect("chat after confirm");
    assert_eq!(after_confirm.pending_proposals, 0);

    // 5. Remove queued message #23 via POST /chat/queued/23/remove
    let _ = client.queued_remove(23).await.expect("queued remove");
    let after_remove = client.chat(None).await.expect("chat after remove");
    assert!(after_remove.queued.is_empty());

    live_task.abort();
}

#[test]
fn provider_failure_offers_checked_memberships_and_keeps_a_retry_explicit() {
    use toolroll_tui::chat_providers::Membership;
    let mut app = loaded_app();
    app.key(key('C'));
    let mut data = app.chat.data.clone().unwrap();
    data.problem = Some("The chat provider couldn't answer; its sign-in may have expired.".into());
    data.busy = false;
    data.messages.clear();
    app.chat.last_submission = Some("What needs me?".into());
    let effects = app.update(Msg::LeadChat(Ok(data.clone())));
    assert!(effects.contains(&Effect::CheckLeadProviders));
    assert_eq!(app.mode, Mode::LeadProviders(None));
    assert_eq!(app.chat.draft, "What needs me?");
    render(&mut app, 48, 24);
    assert!(app.key(key('1')).is_empty());
    assert_eq!(app.mode, Mode::LeadProviders(None));
    let mut agents: toolroll_api::AgentsRead = parse(fake::scenario().agents);
    agents
        .agents
        .iter_mut()
        .find(|row| row.id == "codex")
        .unwrap()
        .state = "signed-in".into();
    app.update(Msg::LeadProvidersChecked(Ok(agents)));
    let click = |app: &mut App, key| {
        let area = app
            .areas
            .lead_provider_controls
            .iter()
            .find(|(_, k)| *k == key)
            .unwrap()
            .0;
        app.mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: area.x,
            row: area.y,
            modifiers: KeyModifiers::NONE,
        })
    };
    for theme in [ThemeName::Light, ThemeName::Dark] {
        app.prefs.theme = Theme::build(theme, Depth::TrueColor, None, &[]).0;
        pairs::check(&mut app, 48, 24);
        assert!(render(&mut app, 48, 24).contains("Codex membership"));
    }
    assert!(click(&mut app, KeyCode::Char('1')).is_empty());
    assert_eq!(app.mode, Mode::LeadProviders(Some(Membership::Codex)));
    let confirmed = render(&mut app, 48, 24);
    assert!(confirmed.contains("50 turns"));
    assert_eq!(
        click(&mut app, KeyCode::Enter),
        [Effect::SwitchLead(Membership::Codex)]
    );
    assert!(app.key(code(KeyCode::Enter)).is_empty());
    let effects = app.update(Msg::LeadSwitched(
        Membership::Codex,
        Ok(toolroll_api::ActOutcome::Done("Saved".into())),
    ));
    assert_eq!(effects, [Effect::FetchLeadChat]);
    assert_eq!(app.mode, Mode::ChatCompose("What needs me?".into()));
    assert!(!app
        .update(Msg::LeadChat(Ok(data)))
        .contains(&Effect::CheckLeadProviders));
}

#[test]
fn provider_check_is_available_without_an_error_and_never_steals_a_new_draft() {
    let mut app = loaded_app();
    app.key(key('C'));
    app.key(key('H'));
    render(&mut app, 100, 30);
    let area = app.areas.lead_providers_button;
    assert_eq!(
        app.mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: area.x,
            row: area.y,
            modifiers: KeyModifiers::NONE
        }),
        [Effect::CheckLeadProviders]
    );
    let checked = render(&mut app, 100, 30);
    assert!(checked.contains("Checking local sign-ins"));
    app.update(Msg::LeadProvidersChecked(Err(
        toolroll_api::ApiError::Unreachable("Offline".into()),
    )));
    assert!(render(&mut app, 100, 30).contains("Offline"));
    assert_eq!(app.key(key('r')), [Effect::CheckLeadProviders]);
    render(&mut app, 100, 30);
    assert_eq!(app.key(key('w')), [Effect::OpenPage("lead-providers")]);
    app.key(code(KeyCode::Esc));
    assert_eq!(app.mode, Mode::ChatCompose("H".into()));
    let mut data = app.chat.data.clone().unwrap();
    data.busy = false;
    data.problem = Some("Confirm the cost on the Chat page.".into());
    assert!(!app
        .update(Msg::LeadChat(Ok(data)))
        .contains(&Effect::CheckLeadProviders));
    app.chat.last_submission = Some("Earlier message".into());
    app.update(Msg::ChatSent(Ok(ChatSendOutcome::Refused(
        "Unavailable".into(),
    ))));
    assert_eq!(app.mode, Mode::ChatCompose("H".into()));
}

#[test]
fn a_missing_membership_opens_the_correct_agent_setup() {
    let mut app = loaded_app();
    app.key(key('C'));
    app.key(code(KeyCode::F(2)));
    let mut agents: toolroll_api::AgentsRead = parse(fake::scenario().agents);
    agents
        .agents
        .iter_mut()
        .find(|row| row.id == "codex")
        .unwrap()
        .state = "not-installed".into();
    app.update(Msg::LeadProvidersChecked(Ok(agents)));
    assert!(render(&mut app, 80, 24).contains("Codex membership · Install"));
    let fx = app.key(key('1'));
    assert!(fx.contains(&Effect::FetchModels));
    assert_eq!(
        app.agents_screen.as_ref().unwrap().agent.as_deref(),
        Some("codex")
    );
}

#[test]
fn click_message_field_type_and_submit_without_a_shortcut() {
    let mut app = loaded_app();
    app.key(key('C'));
    app.key(code(KeyCode::Esc));
    let click = |app: &mut App, area: ratatui::layout::Rect| {
        app.mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: area.x,
            row: area.y,
            modifiers: KeyModifiers::NONE,
        })
    };
    for w in [48, 120] {
        let screen = render(&mut app, w, 28);
        assert!(!screen.contains("i to chat") && !screen.contains("chatbox"));
        assert_eq!(app.areas.lead_send.width, 0);
    }
    let field = app.chat.composer_area;
    click(&mut app, field);
    app.key(key('i'));
    app.paste("nspect");
    app.key(code(KeyCode::Tab));
    assert_eq!(app.mode, Mode::Normal);
    app.key(code(KeyCode::BackTab));
    assert_eq!(app.mode, Mode::ChatCompose("inspect".into()));
    render(&mut app, 48, 28);
    let send = app.areas.lead_send;
    assert!(send.width > 0);
    let fx = click(&mut app, send);
    assert!(matches!(&fx[..], [Effect::ChatSend { message, .. }] if message == "inspect"));
    assert!(click(&mut app, send).is_empty());
}

fn resume_conversation() -> App {
    let mut app = loaded_app();
    app.key(key('C'));
    let mut data = fake::scenario_lead_chat();
    let reply = &mut data["messages"].as_array_mut().unwrap().last_mut().unwrap();
    reply["text"] = json!("The homepage redesign is paused. I can resume it when you’re ready.");
    reply["activity"] = json!(null);
    reply["ask"] = json!(null);
    reply["cards"] = json!([
        {"id":102,"kind":"unhold","label":"Resume work","state":"pending","data":false,
         "lines":["Release homepage-nameplate from its hold","Project: alekseypelletier.com"],"card":null,
         "said":null,"note":null,"primary":{"kind":"confirm","label":"Release hold","irreversible":false,"native":false},
         "dismissable":true,"links":[{"label":"Peek homepage-nameplate","task":"homepage-nameplate","tab":null,"href":"/t/homepage-nameplate"}]},
        {"id":103,"kind":"control","label":"Manage projects","state":"pending","data":false,"lines":[],"card":null,
         "said":null,"note":null,"primary":{"kind":"link","label":"Manage projects","href":"/projects","task":null,"tab":null},
         "dismissable":false,"links":[{"label":"Manage projects","href":"/projects","task":null,"tab":null}]}
    ]);
    data["queued"] = json!([]);
    data["busy"] = json!(false);
    app.update(Msg::LeadChat(Ok(parse(data))));
    app.chat.follow_end();
    app
}

#[test]
fn chat_choices_match_their_mouse_targets_and_keep_numbers_in_drafts() {
    for width in [48, 144] {
        let mut app = resume_conversation();
        render(&mut app, width, 34);
        app.key(key('2'));
        assert!(matches!(&app.mode, Mode::ChatCompose(text) if text == "2"));
        app.key(code(KeyCode::Tab));
        let shown = render(&mut app, width, 34);
        assert_eq!(
            shown.matches("Manage projects (browser)").count(),
            1,
            "{shown}"
        );
        let choices = app.chat.numbered_choices.clone();
        let digit = |hit: &ChatHit| {
            char::from_digit(
                1 + choices.iter().position(|h| h == hit).unwrap() as u32,
                10,
            )
            .unwrap()
        };
        app.key(key(digit(&ChatHit::ManageProjects)));
        assert_eq!(
            app.key(code(KeyCode::Enter)),
            vec![Effect::OpenPage("projects")]
        );
        assert_eq!(app.chat.draft, "2");
        app.key(key(digit(&ChatHit::ConfirmProposal(102))));
        app.key(code(KeyCode::Down));
        assert_eq!(app.chat.current_hit(), Some(&ChatHit::DismissProposal(102)));
        app.key(code(KeyCode::Up));
        assert!(app.key(code(KeyCode::Enter)).is_empty());
        assert!(matches!(app.mode, Mode::ConfirmProposal(_)));
        app.key(code(KeyCode::Esc));
        render(&mut app, width, 34);
        let rect = app
            .chat
            .hits
            .iter()
            .find(|(_, hit)| *hit == ChatHit::DismissProposal(102))
            .unwrap()
            .0;
        let fx = app.mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: rect.x + 5,
            row: rect.y,
            modifiers: KeyModifiers::NONE,
        });
        assert_eq!(
            fx,
            vec![Effect::ProposalAct {
                id: 102,
                op: "dismiss",
                confirm_yes: false
            }]
        );
    }
}

#[test]
fn lead_chat_shows_mission_control_fleet_vitals_above_the_fold() {
    let mut app = loaded_app();
    app.key(key('C'));
    let shown = render(&mut app, 120, 28);
    assert!(
        shown.contains("2 need you"),
        "expected needs-you telemetry in Lead header:\n{shown}"
    );
    assert!(
        shown.contains("2 working"),
        "expected working telemetry in Lead header:\n{shown}"
    );
    assert!(
        shown.contains("D dock task"),
        "expected dock hint in Lead header:\n{shown}"
    );
}
