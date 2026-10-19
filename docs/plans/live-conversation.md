# The live conversation (Agents view) — spec v3, 2026-10-18

Alex's ask, after comparing with herdr: make it easy to see into a running
agent's conversation and steer it. Two gaps, built together:

1. **The transcript is thin.** `src/live.ts` writes only the agent's own words
   plus fixed headlines ("→ running a command"). You cannot see *which*
   command or file, or what came back.
2. **Your notes are not in the conversation.** A steer note's standing lives
   on the task page, not where you watch the agent work.

Out of scope: attachments on notes, typing into the session, Gemini targets
(Gemini keeps kind-only headlines).

v2 folded in Codex round 1 (NO-GO, 11 findings) and Alex's ruling: **command
text and output are a per-project opt-in.** v3 folds in round 2 (findings 7, 9,
10, 11 and three new ones) and records what was built.

## 1. What is shown, and who decides

Two tiers, decided by the **writer** at run start (what is off never reaches
disk):

| Tier | When | What |
|---|---|---|
| Base | always | kinds as today, plus **file paths** (worktree-relative) and **search patterns** |
| Commands | project setting `Show commands in the live view` is on | command text, ✓/✗, and command output tails |

The tool's *name* is never written — only our fixed kind. The secret filter
is described everywhere as **best effort**; the opt-in is the real control.

### The setting (finding 1, Alex's ruling)

Table `live_detail_setting(repo PRIMARY KEY, commands 0/1, updated_by,
updated_at)` — additive, no version bump (like `chat_approval_setting`); off
when absent. **Settings → Project → Live view**: an approver for the
project turns it on with their password AND a single-use nonce the page
minted for that person, project and change (a replayed or copied form changes
nothing); turning it off is one step (csrf). Route
`POST /settings/project/live-view` is cookie-only step-up. Every change is an
action-ledger line (`live view commands`, on/off). `liveLogContext` reads it
once when builder/scout/planner open the live file; a change applies from the
next run.

**The run keeps its own answer (round 2, new P2).** The file's first record is
`{"k":"open","detail":"base"|"commands"}`; the view says "Commands were hidden
for this run" from it, never from today's project setting.

### Targets (closed list — anything else gets none)

| Stream | Tool / item | Tier | Target |
|---|---|---|---|
| Claude | `Edit` `Write` `MultiEdit` `Read` `NotebookEdit` | base | path rule below |
| Claude | `Grep` `Glob` | base | `pattern` ≤ 120 B |
| Claude | `WebFetch` | base | URL host only (no userinfo, no port) |
| Claude | `WebSearch` | base | `query` ≤ 120 B |
| Claude | `Task` | base | `description` ≤ 120 B |
| Claude | `Bash` | commands | `command`: first line, ≤ 300 B, "…" when cut |
| Codex | `file_change` | base | first path (path rule) + "and N more" |
| Codex | `web_search` | base | `query` ≤ 120 B |
| Codex | `command_execution` | commands | `command`, `bash -lc '…'` unwrapped for display |
| any | MCP / unknown | — | none |

With the commands tier off, a command step shows "→ running a command" and
✓/✗ only — no text, no output.

**Path rule (finding 4).** `openLiveLog(root, runId, { base, commands })`:
`base` is the run's trusted worktree, supplied by builder/scout/planner (a
reviewer run with no checkout passes null → every path shows as "a file").
A target is `path.resolve(base, given)`; shown as `path.relative(base, it)`
only when that is non-empty, not absolute and its first component is not
`..`; otherwise "a file outside the project". Lexical only — nothing is
opened, stat'ed or realpath'd; a displayed target never selects a file.

### What redaction is for (threat model, after 11 review rounds)

Redaction catches secrets a tool or agent prints **by accident** — `cat
id_rsa`, an env dump, a token in a curl line, a key pasted into a message.
It is not a defence against output **crafted to dodge it**: an agent that
wants a key on screen can print it reversed, re-encoded or split letter by
letter, and no display filter can stop that. The controls for that case are
the per-project opt-in (commands and output are off by default), the
audience (signed-in people with access to the project, reading through the
console on the machine whose worker runs the agent — the same people who can
already read the run's live diff, which the setting's page says when it is
turned on) and the fact that the file is display state, never evidence. Review rounds 5–11 hardened the key-block rule
against escapes, invisible characters, look-alikes, markers split across
lines/records/reads and fake END lines; further escape-splitting tricks are
out of scope by this rule. Step targets are single arguments: hidden while a
block is open, but they never open or close one.

### Redaction (finding 1)

Applied to every target, every line the agent says, every output line and
everything read back (records and legacy text), **before** truncation:
- `scanForSecrets` (existing), plus a live-view list: `key = value` /
  `key: value` where key matches
  `pass(word|wd)?|secret|token|api[_-]?key|auth(orization)?|bearer|credential|private[_-]?key|session|cookie`
  (case-insensitive); `Authorization:` / `Bearer ` anywhere; URLs with
  userinfo or `token|key|secret|sig|signature|password=` query params.
- A target that hits becomes `[hidden]`; an output line that hits becomes
  `[a line was hidden]`.
- Multi-line: from a `-----BEGIN … -----` line to its `-----END` (or the end
  of the output) every line is hidden as one `[a key block was hidden]`.

### Results (finding 9)

A step's `id` is the writer's own sequence (`s1`…); provider ids map in
memory (≤ 64 open, the `OPEN_TOOLS_CAP`). Rules:
- Claude: opened by top-level `tool_use`. ANY event with a
  `parent_tool_use_id` — words, tools, a subagent's own `result` or `init` —
  is ignored, so a subagent never closes this run's steps; closed by `tool_result` with the same id —
  `ok = is_error !== true`.
- Codex: opened by `item.started`, closed by `item.completed` with the same
  `item.id` (an item that completes unstarted opens and closes at once).
  Commands: `ok = exit_code === 0` (a nonzero code wins over
  `status:"completed"`; a missing code is `ok:null`). Other items:
  `completed → true`, `failed → false`, else `null`.
- A duplicate open id is ignored; a close for an unknown id is dropped.
- A turn end (Claude `result`, Codex `turn.completed|turn.failed`), a new
  session start (planner repairs reuse one observer), and `close()` each
  close every open step with `ok:null` — "ended without a result". Missing
  completion evidence is never success. An event the transport dropped for
  size (exec.ts) leaves its step open until one of those closes it.
- `out` (commands tier only, command steps only): last 20 lines / 4 KiB
  after redaction. Read/search/edit/MCP/error bodies are never stored.

## 2. The file (findings 3, 6)

New writer, new name: `live/<run>.jsonl`. The name is the format; nothing
sniffs content. Old `live/<run>.log` (plain text) is still read until it
ages out; nothing new writes it.

One JSON object per line, every string already redacted + sanitized, each
record ≤ 8 KiB (an oversized record becomes `{"k":"cut","at":…}`); file cap
4 MiB with a final `{"k":"cap"}`:

```
{"k":"open","at":"…","detail":"base"}           // always first: what this run's project allowed
{"k":"start","at":"…"}
{"k":"say","at":"…","t":["line","line"]}
{"k":"step","at":"…","id":"s3","kind":"command","target":"npm test"}
{"k":"done","at":"…","id":"s3","ok":false,"out":["…"]}
```

**Reader hardening (finding 3)** — applies to both names:
- `liveDir` is `lstat`'d: a real directory, not a symlink, else nothing is read.
- Open `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`; `fstat` must be a regular file.
- A window with no LF that fills the whole window is skipped through its
  next LF (scanning up to 64 MiB), yielding one `cut` record / "[a line was
  too long]" and advancing. A finished run's drain, or a line longer than the
  scan, is cut where the scan stopped — the reader never stalls.
- `.log` lines are re-sanitized on read (terminal controls, bidi, secrets).
- `parseLiveRecord(line)` is strict (known `k`, known `kind`, types, caps)
  and re-runs redaction + sanitize on every string; a bad line is skipped.

**Key state rides the cursor.** Whether reading ended inside a key block is
carried line to line, record to record, and from one read to the next: every
response says `inKey`, and the next request sends `inkey=1` (the Agents view,
the run page's poller and `toolroll peek` all carry it). The reader returns
raw text; all cleaning and redaction happens in `liveWindowLines` /
`liveWindowRecords` with that state.

**Cursor generation.** Every response carries `gen` = format + `dev:ino` of
the opened file. A client sends its `gen`; a mismatch (or size < offset) is
`409 replaced` and the client restarts visibly. A `.log` offset is never
used against `.jsonl`.

**Every consumer migrates:** `liveLogPath` → `liveLogPaths` (jsonl, then log);
`listLiveFiles` recognizes both names so an active `.jsonl` is never an
orphan and stays exempt; the 500-file bound counts both; `agent-pulse`
measures whichever exists; scout/planner/builder all write `.jsonl`.

## 3. Two projections

- **Records** (`fragment=transcript&shape=records`) → the Agents view:
  `{ records, nextOffset, gen, final, notes, detail: "base"|"commands" }`.
- **Text** (default shape; the old run page and `toolroll peek`): `say` → its
  lines; `step` → `→ running \`npm test\``; `done` failed → `  ✗ failed`;
  `done` ok → nothing; `.log` passes through re-sanitized.
- `nextOffset` always advances by **consumed bytes**, whatever renders
  (finding 5); `peek-cli`'s `advanceTail` takes `read.nextOffset` even when
  the text is empty.

## 4. Audience (finding 2)

Both shapes and the Agents view's transcript/peek URLs require, in addition
to today's checks (cookie session, run visible/project access, no-store):
`found.runner === options.localRunner`, checked before the read and again
in the post-read re-proof. Another machine's run gets the existing "can be
read on the computer that runs the agent" words.

## 5. Notes in the conversation (finding 7)

A note's own `attached_run`/`mailed_run` move to the next attempt, so they
cannot say which runs a note reached. New append-only table
`steer_note_run(note, run, how ∈ attached|mailed|read, at)` (additive),
written by `attachSteerNotes`, `markSteerMailed`, `ackSteerNote` and
`settleSteerDelivered` as it happens. Once read, a note's `attached_run` IS the
reading run (ack and settle both set it) and never moves again.

`notes` (the records shape, including its `off` answer) = every note with a
`steer_note_run` row for this run, plus — only while this run is the task's
`steeringLiveBuild` — verified notes still pending. Newest 20, plus `older`.
Each: `{ id, author, mine, at, text, standing, readAt }`:
- read by this run → "Read by the agent at …";
- read by another run → "Read in another attempt" (no time);
- unread, this run not live → "Not read in this attempt — the next one gets it";
- otherwise `steerStandingParts` (waiting / not picked up / ended / unverified).

`mine` is `author === viewer`; "You" only then. The client replaces notes whole
on every answer (no stale upserts). Notes ride every answer, including
`{error:"off"}` for another machine's run — project access was already proven.

## 6. Steering the run you see (finding 8, round-2 P1)

The Agents composer posts `run` and `key` (one random key per draft).
`store.fileSteerNoteForRun` does it all in ONE write transaction: validate;
if `key` was used by this author, hand back the same note only when the
stored digest of `[task, run, text]` matches, else refuse `key-reused`; then
require the run to be unfinished, of this task, and under the task's current
live lease ("still the live attempt" — how the note reaches it is steering's
own business, as for any note); insert the note and the `mutation` receipt
together. Nothing is filed on any refusal. Refusals redirect with
`said=steer-ended|steer-invalid|steer-stale`; success redirects with
`sent=<key>`. A form that says `return=agents`, or carries `run` or `key`,
without a well-formed run AND key is refused (400) — never filed unbound. The
composer keeps `{text, key, submitted}` in `sessionStorage` per run: a refusal
brings back the same text under the same key; only a page whose `sent` equals
that key clears it; editing after a send makes a new draft with a new key. The task page's composer
(no `run`) is unchanged.

## 7. The Agents view (finding 10)

`TranscriptPane` → `ConversationPane`:
- `say` → paragraphs; `step` → kind glyph, target in mono (or the kind's
  words), `running…` / ✓ / ✗ / "ended" and the duration once done; a step
  with `out` is a `<details>` with a `<pre>`. Note → bubble with standing.
- Steps are kept by id (a `done` updates its row); 1,500 entries kept.
- Reading continues until `final` (no 40-window cap): up to 50 windows per
  turn, then the next turn starts at once.
- Each effect run is its own generation; a stale response is discarded.
  A failed read (HTTP or network) keeps what was shown and says "Couldn't
  read the conversation just now. Trying again." (`error`) until one succeeds.
  Scroll-pinning follows a revision counter and pins whichever element is
  scrolling — the pane on a desk, the `[data-agent-scroll]` view on a phone.
- A step with no result once the run is final shows "No result"; `ok:null`
  shows "Ended without a result"; neither shows a duration or a ✓.
- With the commands tier off, one quiet line under the pane: "Commands are
  hidden for this project" linking to the setting.
- Text only — no innerHTML; the run page keeps its textContent poller.

## 8. Tests (finding 11)

- Writer: every target rule; path containment (`..`, absolute, sibling
  prefix `/wt-other`, null base); redaction (generic `PASSWORD=`, bearer,
  URL token, PEM block, before-truncation); tier off → no command text or
  output on disk; pairing (dup id, unknown close, subagent ignored, turn end
  / new session / close → `ok:null`, nonzero exit beats completed, missing
  exit → null); record cap → `cut`; file cap → `cap`; O_EXCL.
- Reader: FIFO not blocked (O_NONBLOCK, refused), symlinked dir/file refused,
  oversized line skipped and advancing, UTF-8 boundary, forged records
  skipped, strings re-redacted, `.log` re-sanitized, gen mismatch → 409.
- Projections: text golden; empty projection still advances; peek
  `advanceTail` advances on empty text.
- Sweep: active `.jsonl` exempt; mixed names over the 500 bound.
- Endpoint: foreign runner refused (both shapes); notes by run association,
  pending only while live, "earlier attempt", `mine`; old shape unchanged.
- Steer: stale `expectRun` refused, nothing filed; idempotent double submit.
- Setting: ceremony (nonce, password, digest), off is one step, ledger line,
  writer reads it at open.
- View: fixture renders steps, failed command expands, note "Waiting…" →
  "Read …", stale response discarded, phone width.

## 9. Order of work (all built on branch live-conversation)

1. live.ts writer/reader/parse/redaction + projections + consumers
   (pulse, peek, sweep) + tests.
2. Setting table + store + settings ceremony + tests.
3. Endpoint (shape, gen, notes, runner guard) + steer `expectRun` + tests.
4. ConversationPane + view tests.
