# Project memory

Each project keeps one memory in the plane's database, and every lead and crew agent reads it before working. It has four kinds of entry:

| Kind | What it is | When it is loaded |
| --- | --- | --- |
| Instructions | Short standing preferences, at most 4 KB | Always |
| References | Pasted notes or committed `.md`/`.txt` files | When the task's title, goal or touched paths match |
| Lessons | Advice distilled from finished results, adopted by a person | When the same paths are in play |
| Decisions | A settled choice, its reason, who decided and where it came from | One line each in every brief; the reason loads by id |

Nothing in memory grants permission, changes scope or waives a check. A crew agent reports; a person, or the lead's confirmed card, records.

## Reading and searching

- **Console:** Settings → Knowledge shows the intro, a search box over the whole memory, proposals from sessions, decisions, code search, instructions, references and lessons for the chosen project.
- **Chat:** the lead searches project memory before asking you something the project may have settled, reads a decision by id, and cites what it relies on.
- **Terminal:** `toolroll memory search "<words>" --repo PATH`, `memory decisions`, `memory show <id>`.
- **Agents:** `toolroll skills get knowledge` prints the guide agents follow; the AGENTS.md block installed in each repo points there.

Search covers decisions, instructions, references, lessons and the conversations you may read: your own private chats and the team conversations you are in. Nobody sees another person's private chat.

## Changing it

- Say a settled choice in chat and confirm the lead's **Record decision** card, or run `memory decide "<one sentence>" --why "<reason>"`. Replace an older decision with `--supersedes <id>`; retire one with `memory retire <id> --reason "<why>"`. Decisions are retired, never deleted, and every change keeps its history. Changing memory (`memory decide`, `memory retire`, `memory apply`) is a person's act: your own sign-in at this computer or in the console, never the lead's token or an API token. The lead proposes decisions in chat for you to confirm.
- Instructions and references change on the Knowledge page or through the lead's knowledge cards; every revision can be restored.

## The backward pass

Memory improves from what actually happened, under a person's review. `toolroll memory propose --repo PATH` reads recent sessions: the plane's own lead conversations and crew runs, plus the Claude Code and Codex session files on this machine for the project. Each session is distilled (words kept, tool calls one line, outputs clipped, secret-bearing lines dropped) and audited once per memory version by the chat model: which instructions helped, which were ignored or caused harm, and which mistakes no instruction or decision covers. Every claim must carry a verbatim quote from the session or it is discarded.

Gaps accumulate in a ledger across runs. A proposal appears only when the same gap is seen in two distinct sessions; a removal only when following the instruction caused harm in two sessions. Instructions have a 4 KB budget: over it, an addition is offered as a decision instead of growing the file. Proposals show their diff and quotes on the Knowledge page and in `memory review`; **Accept** writes through the ordinary knowledge or decision store as you, **Reject** is remembered until more sessions corroborate the same gap. `memory status` reports the surface version, budget, sessions analysed, open gaps and pending proposals.

Nothing leaves the machine except the distilled trace sent to the chat model you already configured.
