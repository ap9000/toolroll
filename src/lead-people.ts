/** Who the lead works with: the people on this installation who share a project with its owner, the subagents in
 * those projects, and the team chats the owner is in. The bundle carries one line each (lead-context.ts); get_person
 * reads one in full, with their open work. Ids stay the same from turn to turn however the list changes: p and c plus a
 * short digest of the account or team chat, t plus the subagent's number. In a team chat the lead speaks for the room,
 * so only that room and its members are listed. Only the owner's own projects are listed, by their r1.. ids; first
 * names are shown on purpose, everything else is scrubbed by the caller. */
import { createHash } from "node:crypto";
import type { Store, SubagentRow } from "./store.js";
import { firstNameOf } from "./lead-context.js";
import { labelOf, nameOf, zonesOf } from "./subagent-admin.js";
import { parseSoul } from "./subagents.js";
import { deskOf } from "./subagent-desk.js";

export type PersonEntry = { id: string; account: string; name: string; role: string; projects: string[]; profile: string | null };
export type SubagentEntry = { id: string; mate: SubagentRow; name: string; role: string; project: string };
export type TeamEntry = { id: string; conversation: string; name: string; members: string[]; purpose: string; projects: string[] };
export type PeopleIndex = { people: PersonEntry[]; subagents: SubagentEntry[]; teams: TeamEntry[] };

const OPEN_TASK = new Set(["queued", "running", "failed"]);
/** get_person's id shapes. */
export const PERSON_ID = /^(p[0-9a-f]{8}|t[0-9]{1,9}|c[0-9a-f]{8})$/;
const stableId = (prefix: "p" | "c", key: string) => `${prefix}${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;

/** The team chat this conversation is, or null when it is the person's own chat with their lead. */
export function teamRoomOf(store: Store, thread: number | undefined): string | null {
  if (thread === undefined) return null;
  try {
    const row = store.handle.prepare("SELECT id FROM team_conversation WHERE thread = ?").get(thread);
    return row === undefined ? null : String(row["id"]);
  } catch { return null; } // an older store has no team chats
}
const line = (text: string, max: number) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };

/** Everyone the owner's lead works with, in order; in a team chat (`room`), only that room and its members. */
export function peopleIndexOf(store: Store, owner: string, repos: readonly string[], room: string | null = null): PeopleIndex {
  const label = (repo: string) => { const index = repos.indexOf(repo); return index === -1 ? null : `r${index + 1}`; };
  const named = (list: readonly string[]) => list.map(label).filter((one): one is string => one !== null);
  const inRoom = room === null ? null : new Set(store.handle.prepare("SELECT account FROM team_participant WHERE conversation = ? AND active = 1").all(room).map(one => String(one["account"])));
  const people = store.accountFacts()
    .filter(one => one.name !== owner && one.revokedAt === null && (inRoom === null || inRoom.has(one.name)))
    .map(one => ({ one, shared: one.projects === null ? [...repos] : repos.filter(repo => one.projects!.includes(repo)) }))
    .filter(({ shared }) => shared.length > 0)
    .map(({ one, shared }) => ({ id: stableId("p", one.name), account: one.name, name: firstNameOf(one.name) || one.name,
      role: one.role === "approver" ? "approves work" : "watches work",
      // No person has a written profile yet; the field is there for when one does.
      projects: named(shared), profile: null }));
  // subagents are not members of a team chat.
  const subagents = room !== null ? [] : store.subagents(repos).map(mate => {
    const soul = parseSoul(mate.soul);
    return { id: `t${mate.id}`, mate, name: nameOf(mate), role: soul.ok ? soul.soul.role : labelOf(mate), project: label(mate.repo) ?? "" };
  });
  let teams: TeamEntry[] = [];
  try {
    const rows = store.handle.prepare(`SELECT c.id, c.title, c.projects_json, l.name AS lead, l.instructions FROM team_conversation c JOIN team_lead l ON l.id = c.lead
      WHERE EXISTS (SELECT 1 FROM team_participant p WHERE p.conversation = c.id AND p.account = ? AND p.active = 1)
         OR (c.visibility = 'team' AND EXISTS (SELECT 1 FROM team_lead_member m WHERE m.lead = c.lead AND m.account = ? AND m.active = 1))
      ORDER BY c.created_at, c.id`).all(owner, owner);
    teams = rows.filter(row => room === null || String(row["id"]) === room).map(row => {
      const members = store.handle.prepare("SELECT account FROM team_participant WHERE conversation = ? AND active = 1 ORDER BY account").all(row["id"])
        .map(one => String(one["account"])).map(account => account === owner ? "you" : firstNameOf(account) || account);
      let projects: string[] = [];
      try { const listed = JSON.parse(String(row["projects_json"])); if (Array.isArray(listed)) projects = named(listed.map(String)); } catch { /* none named */ }
      const purpose = String(row["instructions"] ?? "").split("\n").map(one => one.trim()).find(one => one !== "") ?? "";
      return { id: stableId("c", String(row["id"])), conversation: String(row["id"]), name: String(row["title"]), members, purpose: purpose || String(row["lead"]), projects };
    });
  } catch { /* an older store has no team chats */ }
  return { people, subagents, teams };
}

/** One line each, as the bundle carries them. Free text goes through `redact`; names and project ids do not. */
export function peopleLines(index: PeopleIndex, redact: (text: string) => string) {
  return {
    people: index.people.map(one => `${one.id} ${one.name}: ${one.role}; ${one.projects.join(", ")}${one.profile === null ? "" : `; ${line(redact(one.profile), 120)}`}`),
    subagents: index.subagents.map(one => `${one.id} ${one.name}: ${line(redact(one.role), 60)}${one.project === "" ? "" : ` (${one.project})`}`),
    teams: index.teams.map(one => `${one.id} ${line(redact(one.name), 60)}: ${one.members.join(", ")}; ${line(redact(one.purpose), 120)}`),
  };
}

/** The work still open for one person: tasks last filed, approved or handed to them in the owner's projects, and flow cards they own. */
function openWorkOf(store: Store, account: string, repos: readonly string[]) {
  const repoId = (repo: string) => `r${repos.indexOf(repo) + 1}`;
  const tasks = repos.length === 0 ? [] : store.handle.prepare(`SELECT r.external_id AS task, r.repo FROM task_ref r JOIN task_act a ON a.id = (SELECT MAX(id) FROM task_act WHERE task_ref = r.id AND act IN ('filed', 'approved', 'asked'))
      WHERE r.repo IN (${repos.map(() => "?").join(", ")}) AND ((a.act IN ('filed', 'approved') AND a.account = ?) OR (a.act = 'asked' AND a.person = ?)) ORDER BY r.id DESC LIMIT 100`).all(...repos, account, account)
    .flatMap(row => { const task = store.getTask(String(row["task"])); return task !== null && OPEN_TASK.has(task.state) ? [{ task: task.id, title: task.title, state: task.state, repo: repoId(String(row["repo"])) }] : []; })
    .slice(0, 10);
  const cards = repos.flatMap(repo => store.activeFlowCards(repo).filter(card => card.owner === account).map(card => ({ card: card.id, flow: card.flow, title: card.title, zone: card.stage, repo: repoId(repo) }))).slice(0, 10);
  return { tasks, cards };
}

/** One entry in full by its id (p3fa91c2e, t5, c07b1d9a4) or by name; the candidates when a name fits several, null when
 * none. In a team chat (`room`), only that room and its members. */
export function personEntry(store: Store, owner: string, repos: readonly string[], ask: { id?: string; name?: string }, room: string | null = null):
  { found: Record<string, unknown> } | { several: { id: string; name: string; kind: string }[] } | null {
  const index = peopleIndexOf(store, owner, repos, room);
  const wanted = ask.name?.trim().toLowerCase() ?? "";
  const all = [
    ...index.people.map(one => ({ id: one.id, name: one.name, kind: "person", also: one.account })),
    ...index.subagents.map(one => ({ id: one.id, name: one.name, kind: "subagent", also: one.mate.handle })),
    ...index.teams.map(one => ({ id: one.id, name: one.name, kind: "team chat", also: "" })),
  ];
  const hits = ask.id !== undefined ? all.filter(one => one.id === ask.id)
    : all.filter(one => one.name.toLowerCase() === wanted || one.also.toLowerCase() === wanted);
  const loose = hits.length > 0 || wanted.length < 2 ? hits : all.filter(one => one.name.toLowerCase().includes(wanted));
  if (loose.length === 0) return null;
  if (loose.length > 1) return { several: loose.map(({ id, name, kind }) => ({ id, name, kind })) };
  const id = loose[0]!.id;
  const person = index.people.find(one => one.id === id);
  if (person !== undefined) {
    const work = openWorkOf(store, person.account, repos);
    return { found: { id, kind: "person", name: person.name, role: person.role, projects: person.projects, profile: person.profile, openTasks: work.tasks, openCards: work.cards } };
  }
  const mate = index.subagents.find(one => one.id === id);
  if (mate !== undefined) {
    const flows = new Set([...zonesOf(store, mate.mate).map(one => `${one.flow}:${one.zone}`)]);
    const desk = deskOf(store, mate.mate)?.id ?? null;
    const cards = store.activeFlowCards(mate.mate.repo).filter(card => flows.has(`${card.flow}:${card.stage}`) || card.flow === desk)
      .slice(0, 10).map(card => ({ card: card.id, flow: card.flow, title: card.title, zone: card.stage }));
    return { found: { id, kind: "subagent", name: mate.name, role: mate.role, project: mate.project, working: mate.mate.state === "active", soul: mate.mate.soul,
      worksOn: zonesOf(store, mate.mate).map(one => ({ flow: one.flowName, zone: one.title, how: one.kind })),
      openTasks: cards, questions: store.openSubagentQuestions([mate.mate.id]).map(one => ({ question: one.id, asks: one.question })),
      more: "get_subagents with this subagent's number reads its memory, routines, tools and recent log." } };
  }
  const team = index.teams.find(one => one.id === id)!;
  const purpose = String(store.handle.prepare("SELECT l.instructions FROM team_conversation c JOIN team_lead l ON l.id = c.lead WHERE c.id = ?").get(team.conversation)?.["instructions"] ?? "");
  const tasks = store.handle.prepare("SELECT r.external_id AS task, r.repo FROM team_task_owner o JOIN task_ref r ON r.id = o.task_ref WHERE o.conversation = ? ORDER BY r.id DESC LIMIT 100").all(team.conversation)
    .flatMap(row => { const task = store.getTask(String(row["task"])), repo = String(row["repo"]); return task !== null && OPEN_TASK.has(task.state) && repos.includes(repo) ? [{ task: task.id, title: task.title, state: task.state, repo: `r${repos.indexOf(repo) + 1}` }] : []; })
    .slice(0, 10);
  return { found: { id, kind: "team chat", name: team.name, members: team.members, purpose: line(purpose || team.purpose, 600), projects: team.projects, openTasks: tasks } };
}
