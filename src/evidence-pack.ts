/**
 * v103: a change's evidence pack. It is everything an auditor asks about one
 * piece of work, in one place: who asked for it, the exact terms and who
 * approved them (under which rules), which agents ran and what they cost,
 * what changed, the checks, who marked it complete, where it was published,
 * and every ledger entry about it with its seal. JSON for tools; the same
 * facts as a printable page for people.
 *
 * Each ledger entry carries its seal (`prev`, `hash`), so anyone can
 * recompute it; the chain report and the latest checkpoint tie those
 * entries to the whole ledger.
 */
import { createHash } from "node:crypto";
import { rulesWords, type Filer } from "./approval-policy.js";
import { assignmentOf, type AssignmentAccess, type AssignmentSnapshot } from "./assignment.js";
import { projectName } from "./project.js";
import { changedFilesOf } from "./result-completion.js";
import type { SealedLedgerEntry, Store } from "./store.js";
import type { LedgerChainReport } from "./ledger-chain.js";
import { html, htmlString, joinHtml, styleElement, type Html } from "./html.js";

export const EVIDENCE_PACK_FORMAT = "standing-orders/evidence-pack/v1";
/** How to recheck one entry's seal, for whoever reads the JSON. */
export const SEAL_RECIPE = 'hash = sha256(prev + "\\n" + JSON.stringify([id, at, actor, repo, taskId, runId, action, outcome, source, detail]))';
/** A pack carries up to this many of the task's own entries, and the newest this many requests made about it. */
const MAX_ENTRIES = 5000;
const MAX_REQUESTS = 500;

type SealedEntry = SealedLedgerEntry;

export type EvidencePack = {
  format: typeof EVIDENCE_PACK_FORMAT;
  generatedAt: string;
  generatedBy: string;
  task: { id: string; title: string; state: string; repo: string | null; project: string | null; filedAt: string };
  rules: { now: string; changes: { id: number; at: string; by: string; change: string | null }[] } | null;
  /** The task and each revision of it, oldest first. */
  versions: {
    id: string; title: string; state: string; filedAt: string; filedBy: Filer | null;
    scope: {
      goal: string; outOfScope: string | null; touches: string[]; acceptance: { id: string; statement: string }[];
      budgetUsd: number | null; digest: string;
      approved: { by: string; at: string; digest: string; basis: "person" | "mode"; current: boolean } | null;
      writtenBy: { digest: string; author: string; at: string }[];
      approvals: { digest: string; approver: string; at: string }[];
    } | null;
    runs: {
      id: number; role: string; agent: string; model: string | null; outcome: string | null; reason: string | null;
      base: string | null; head: string | null; startedAt: string; finishedAt: string | null;
      tokensIn: number | null; tokensOut: number | null; costUsd: number | null;
      /** The files a build changed (renames on both sides); null when its record can't be read whole. */
      changedFiles: string[] | null;
      diff: { sha256: string; bytes: number; complete: boolean } | null;
      proof: { verdict: string; decidedAt: string; reasons: string[] } | null;
      publication: { repo: string; branch: string; commit: string; state: string; pr: number | null; url: string | null; remoteState: string | null; checks: string | null } | null;
    }[];
  }[];
  result: {
    runId: number; base: string | null; head: string | null; kind: string | null;
    checks: { status: string; command: string | null; exitCode: number | null; detail: string };
    completedBy: string | null; completedAt: string | null; caveats: string[];
    publication: AssignmentSnapshot["publication"];
  } | null;
  totals: { runs: number; costUsd: number; tokensIn: number; tokensOut: number };
  ledger: {
    entries: SealedEntry[];
    /** More entries (or requests) exist than a pack carries; the ledger export has them all. */
    truncated: boolean;
    /** `checkedAt`: when the whole chain was last walked (entries since were checked as they came). */
    chain: { ok: boolean; entries: number; through: number | null; head: string; problem: string | null; checkedAt: string | null };
    checkpoint: { through: number; hash: string; at: string } | null;
    recipe: string;
  };
  /** sha256 of this pack's JSON without this field. */
  digest: string;
};

/** The pack for one task (the whole family: the task and every revision), as `who` may see it. null when they can't. */
export function evidencePack(store: Store, taskId: string, access: AssignmentAccess, who: string, now: Date, evidenceRoot: string, checked?: LedgerChainReport): EvidencePack | null {
  const family = store.taskFamilyOf(taskId, access.repos, access.principal === "operator" && access.includeUnplaced === true);
  if (family === null) return null;
  const chain = checked ?? store.ledgerChain();
  const repo = family.root.repo;
  const versions = family.versions.map(version => {
    const scope = store.getScope(version.id);
    const history = store.scopeHistory(version.id);
    const runs = store.runsFor(version.refId).map(run => {
      const artifacts = store.artifactsFor(run.id);
      const diff = artifacts.find(one => one.kind === "diff");
      const proof = store.proofVerdictFor(run.id);
      const publication = store.publicationForRun(run.id);
      const builds = run.role === "builder" || run.role === "repair";
      return {
        id: run.id, role: run.role, agent: run.provider, model: run.model, outcome: run.outcome, reason: run.reason,
        base: run.baseRevision, head: run.headRevision, startedAt: run.startedAt, finishedAt: run.finishedAt,
        tokensIn: run.tokensIn, tokensOut: run.tokensOut, costUsd: run.costUsd,
        changedFiles: builds && artifacts.some(one => one.kind === "diff-stat") ? changedFilesOf(store, run.id, evidenceRoot) : builds ? null : [],
        diff: diff === undefined ? null : { sha256: diff.sha256, bytes: diff.bytesOriginal, complete: !diff.truncated && !diff.redacted },
        proof: proof === null ? null : { verdict: proof.verdict, decidedAt: proof.decidedAt, reasons: proof.reasons },
        publication: publication === null ? null : { repo: publication.githubRepo, branch: publication.head, commit: publication.headSha, state: publication.state,
          pr: publication.prNumber, url: publication.prUrl, remoteState: publication.remoteState, checks: publication.lastCheckState },
      };
    });
    return {
      id: version.id, title: version.title, state: version.state, filedAt: version.createdAt, filedBy: store.taskFiler(version.id),
      scope: scope === null ? null : {
        goal: scope.goal, outOfScope: scope.outOfScope, touches: scope.touches, acceptance: scope.acceptance.map(one => ({ id: one.id, statement: one.statement })),
        budgetUsd: scope.budgetMicrousd === null ? null : scope.budgetMicrousd / 1_000_000, digest: scope.digest,
        approved: scope.approvedBy === null || scope.approvedAt === null || scope.approvedDigest === null ? null
          : { by: scope.approvedBy, at: scope.approvedAt, digest: scope.approvedDigest, basis: scope.approvalBasis === "mode" ? "mode" as const : "person" as const, current: scope.approvedDigest === scope.digest },
        writtenBy: history.authors,
        approvals: history.votes,
      },
      runs,
    };
  });
  const assignment = assignmentOf(store, family.current.id, now, access, evidenceRoot);
  const receipt = assignment?.receipt ?? null;
  const runIds = versions.flatMap(version => version.runs.map(run => run.id));
  const { entries, truncated } = store.taskLedgerEntries({ taskIds: family.versions.map(version => version.id), runIds }, { entries: MAX_ENTRIES, requests: MAX_REQUESTS });
  const allRuns = versions.flatMap(version => version.runs);
  const sum = (pick: (run: (typeof allRuns)[number]) => number | null) => allRuns.reduce((total, run) => total + (pick(run) ?? 0), 0);
  const latest = store.ledgerCheckpoints(1)[0] ?? null;
  const rules = repo === null ? null : store.approvalRules(repo);
  const body: Omit<EvidencePack, "digest"> = {
    format: EVIDENCE_PACK_FORMAT,
    generatedAt: now.toISOString(),
    generatedBy: who,
    task: { id: family.root.id, title: family.current.title, state: family.current.state, repo, project: repo === null ? null : projectName(repo), filedAt: family.root.createdAt },
    rules: repo === null || rules === null ? null : {
      now: rulesWords(rules),
      changes: store.actionLedger({ repos: [repo], source: "policy", limit: 101 }).filter(one => one.action === "approval rules changed").reverse()
        .map(one => ({ id: one.id, at: one.at, by: one.actor, change: one.detail })),
    },
    versions,
    result: receipt === null ? null : {
      runId: receipt.runId, base: receipt.base, head: receipt.head, kind: receipt.completionKind,
      checks: { status: receipt.checks.status, command: receipt.checks.command, exitCode: receipt.checks.exitCode, detail: receipt.checks.detail },
      completedBy: assignment?.completion?.actor ?? null, completedAt: assignment?.completion?.at ?? null, caveats: receipt.caveats,
      publication: assignment?.publication ?? null,
    },
    totals: { runs: allRuns.length, costUsd: Math.round(sum(run => run.costUsd) * 1e6) / 1e6, tokensIn: sum(run => run.tokensIn), tokensOut: sum(run => run.tokensOut) },
    ledger: {
      entries,
      truncated,
      chain: { ok: chain.ok, entries: chain.entries, through: chain.through, head: chain.head, problem: chain.problem?.what ?? null, checkedAt: chain.checkedAt },
      checkpoint: latest === null ? null : { through: latest.through, hash: latest.hash, at: latest.at },
      recipe: SEAL_RECIPE,
    },
  };
  return { ...body, digest: packDigest(body) };
}

export function packDigest(body: Omit<EvidencePack, "digest">): string {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
}

/** A day as the export takes it (YYYY-MM-DD, UTC), or null. */
export function exportDay(value: string | null): string | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const day = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value ? null : day.toISOString();
}

export type LedgerExport = {
  format: "standing-orders/ledger-export/v1";
  generatedAt: string; generatedBy: string;
  from: string; to: string;
  chain: EvidencePack["ledger"]["chain"];
  checkpoint: EvidencePack["ledger"]["checkpoint"];
  recipe: string;
  entries: SealedEntry[];
  /** An evidence pack for every task the range's entries name. */
  packs: EvidencePack[];
  truncated: { entries: boolean; packs: boolean };
};

const EXPORT_ENTRIES = 100_000;
/** Entries per piece of an export: small enough that a slow, steady reader finishes each well inside the server's minute. */
const EXPORT_PAGE = 250;
const EXPORT_PACKS = 200;

/** Every ledger entry in [from, to) that `who` may read, sealed, with a pack for each task they name: one JSON
 * document (a `LedgerExport`), a piece at a time (a page of entries, or one pack), so an export never holds
 * the whole range at once. */
export function* ledgerExportChunks(store: Store, range: { from: string; to: string }, scope: { repos: readonly string[] | null; instance: boolean }, access: AssignmentAccess, who: string, now: Date, evidenceRoot: string): Generator<string, void, undefined> {
  // An export is the record someone takes away: the whole chain is walked for it (or was, within the last minute).
  const chain = store.ledgerChain({ full: true, fresh: 60_000 });
  const latest = store.ledgerCheckpoints(1)[0] ?? null;
  const head = {
    format: "standing-orders/ledger-export/v1", generatedAt: now.toISOString(), generatedBy: who, from: range.from, to: range.to,
    chain: { ok: chain.ok, entries: chain.entries, through: chain.through, head: chain.head, problem: chain.problem?.what ?? null, checkedAt: chain.checkedAt },
    checkpoint: latest === null ? null : { through: latest.through, hash: latest.hash, at: latest.at }, recipe: SEAL_RECIPE,
  };
  yield `${JSON.stringify(head).slice(0, -1)},"entries":[`;
  const named: string[] = [];
  const seen = new Set<string>();
  let after = 0, written = 0, moreEntries = false;
  for (;;) {
    const page = store.sealedLedgerEntries({ ...range, repos: scope.repos, instance: scope.instance, after, limit: EXPORT_PAGE });
    const kept = page.slice(0, Math.min(EXPORT_PAGE, EXPORT_ENTRIES - written));
    if (kept.length > 0) yield `${written === 0 ? "" : ","}${kept.map(one => JSON.stringify(one)).join(",")}`;
    written += kept.length;
    for (const one of kept) if (one.taskId !== null && !seen.has(one.taskId)) { seen.add(one.taskId); named.push(one.taskId); }
    if (page.length <= EXPORT_PAGE) break;
    if (written >= EXPORT_ENTRIES) { moreEntries = true; break; }
    after = kept.at(-1)!.id;
  }
  yield `],"packs":[`;
  const packed = new Set<string>();
  let packs = 0, morePacks = false;
  for (const taskId of named) {
    if (packed.has(taskId)) continue;
    const family = store.taskFamilyOf(taskId, access.repos, access.principal === "operator" && access.includeUnplaced === true);
    if (family === null || packed.has(family.root.id)) { packed.add(taskId); continue; }
    for (const version of family.versions) packed.add(version.id);
    packed.add(family.root.id);
    if (packs === EXPORT_PACKS) { morePacks = true; break; }
    const pack = evidencePack(store, family.root.id, access, who, now, evidenceRoot, chain);
    if (pack === null) continue;
    yield `${packs === 0 ? "" : ","}${JSON.stringify(pack)}`;
    packs++;
  }
  yield `],"truncated":${JSON.stringify({ entries: moreEntries, packs: morePacks })}}`;
}
// ---- The printable page -----------------------------------------------------

const when = (at: string | null): Html => at === null ? html`—` : html`${at.slice(0, 16).replace("T", " ")} UTC`;
const short = (hash: string | null): Html => hash === null ? html`—` : html`<code title="${hash}">${hash.slice(0, 12)}</code>`;
const usd = (value: number | null) => value === null ? "—" : `$${value.toFixed(value < 1 ? 4 : 2)}`;
/** Only a web address links; anything else (a stored value that isn't one) is shown as text. */
const link = (url: string): Html => /^https:\/\/[^\s"'<>]+$/.test(url) ? html`<a href="${url}">${url}</a>` : html`${url}`;
const filer = (who: Filer | null): Html => who === null || who.name === null ? html`automation` : who.kind === "person" ? html`${who.name}` : html`${who.name} (${who.kind})`;

export const EVIDENCE_PACK_CSS = `.evidence-pack{max-width:960px;min-width:0}.evidence-pack h1{margin:0}.evidence-pack h2{font-size:.9375rem;margin:24px 0 8px}.evidence-pack h3{font-size:.875rem;margin:16px 0 6px}` +
  `.evidence-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline}.evidence-pack dl{display:grid;grid-template-columns:minmax(120px,180px) minmax(0,1fr);gap:4px 16px;margin:0}` +
  `.evidence-pack dt{color:var(--muted-foreground);font-size:.8125rem}.evidence-pack dd{margin:0;min-width:0;overflow-wrap:anywhere}.evidence-pack table{width:100%;border-collapse:collapse;font-size:.8125rem}` +
  `.evidence-pack th,.evidence-pack td{text-align:left;padding:5px 8px 5px 0;border-bottom:1px solid var(--border);vertical-align:top;overflow-wrap:anywhere}.evidence-pack th{font-weight:500;color:var(--muted-foreground)}` +
  `.evidence-pack code{font-family:var(--font-mono);font-size:.75rem}.evidence-pack .files{margin:4px 0 0;padding-left:18px;font-family:var(--font-mono);font-size:.75rem}.evidence-pack .criteria{margin:0;padding-left:18px}.evidence-chain{font-size:.8125rem;margin:8px 0 0}` +
  `.evidence-chain.ok strong{color:var(--success)}.evidence-table{overflow-x:auto}.evidence-foot{margin-top:24px;font-size:.75rem;color:var(--muted-foreground);overflow-wrap:anywhere}` +
  `@media(max-width:600px){.evidence-pack dl{grid-template-columns:minmax(0,1fr)}.evidence-pack dd{margin-bottom:6px}}` +
  `@media print{.side,.tabbar,.mobile-top,.scope-bar,.banner,.evidence-actions{display:none!important}body,.app,.content,.detail,main{background:#fff!important;color:#000!important;margin:0!important;padding:0!important;box-shadow:none!important;border:0!important}` +
  `.evidence-pack{max-width:none}.evidence-pack section{break-inside:avoid-page}.evidence-pack a{color:#000;text-decoration:none}}`;

/** The pack as a page: the same facts, in the order an auditor reads them. No script. */
export function evidencePackHtml(pack: EvidencePack): Html {
  const task = pack.task;
  const chain = pack.ledger.chain.ok
    ? html`<p class="evidence-chain ok" data-evidence-chain="ok"><strong>Ledger chain verified</strong> · ${pack.ledger.chain.entries} entries · head ${short(pack.ledger.chain.head)}${pack.ledger.chain.checkedAt === null ? "" : html` · checked in full ${when(pack.ledger.chain.checkedAt)}`}${pack.ledger.checkpoint === null ? "" : html` · last checkpoint at entry #${pack.ledger.checkpoint.through}`}</p>`
    : html`<p class="evidence-chain problem" role="alert" data-evidence-chain="broken"><strong>Ledger chain broken</strong> · ${pack.ledger.chain.problem}</p>`;
  const versions = pack.versions.map((version, index) => {
    const scope = version.scope;
    const approved = scope?.approved ?? null;
    const approvals = scope === null ? [] : scope.approvals.filter(one => one.digest === (approved?.digest ?? scope.digest));
    const rows: Array<[string, Html]> = [
      ["Filed", html`${when(version.filedAt)} by ${filer(version.filedBy)}`],
      ...(scope === null ? [["Scope", html`None written`] as [string, Html]] : [
        ["Goal", html`${scope.goal}`] as [string, Html],
        ...(scope.touches.length ? [["Touches", joinHtml(scope.touches, ", ")] as [string, Html]] : []),
        ...(scope.acceptance.length ? [["Acceptance", html`<ol class="criteria">${scope.acceptance.map(one => html`<li>${one.statement}</li>`)}</ol>`] as [string, Html]] : []),
        ...(scope.writtenBy.length ? [["Scope written by", joinHtml([...new Set(scope.writtenBy.map(one => one.author))], ", ")] as [string, Html]] : []),
        ["Approved", approved === null ? html`Not approved` : html`${approved.by}${approved.basis === "mode" ? " (operating mode)" : ""} · ${when(approved.at)}${approved.current ? "" : " · the scope changed after this"}`] as [string, Html],
        ...(approvals.length > 1 ? [["Approvals", joinHtml(approvals.map(one => html`${one.approver} · ${when(one.at)}`), html`<br>`)] as [string, Html]] : []),
        ["Scope digest", short(scope.digest)] as [string, Html],
      ]),
    ];
    const runs = version.runs.length === 0 ? html`<p class="meta">No agent ran.</p>` :
      html`<div class="evidence-table"><table><thead><tr><th>Run</th><th>Role</th><th>Agent</th><th>Outcome</th><th>Cost</th><th>Finished</th><th>Commit</th></tr></thead><tbody>${
      version.runs.map(run => html`<tr><td><a href="/r/${run.id}">#${run.id}</a></td><td>${run.role}</td><td>${run.agent}${run.model ? html` · ${run.model}` : ""}</td><td>${run.outcome ?? "running"}</td><td>${usd(run.costUsd)}</td><td>${when(run.finishedAt)}</td><td>${short(run.head)}</td></tr>`)
      }</tbody></table></div>`;
    const changes = version.runs.filter(run => run.role === "builder" || run.role === "repair").map(run =>
      html`<p class="meta">Run #${run.id}${run.diff === null ? "" : html` · diff ${short(run.diff.sha256)}${run.diff.complete ? "" : " (partial)"}`}</p>${
      run.changedFiles === null ? html`<p class="meta">Its changed files couldn't be read.</p>` : run.changedFiles.length === 0 ? html`<p class="meta">No files changed.</p>` : html`<ul class="files">${run.changedFiles.map(file => html`<li>${file}</li>`)}</ul>`}`);
    return html`<section data-evidence-version="${version.id}"><h2>${pack.versions.length > 1 ? `${index === 0 ? "Request" : `Revision ${index}`} · ` : "Request and approval · "}${version.id}</h2><dl>${rows.map(([label, value]) => html`<dt>${label}</dt><dd>${value}</dd>`)}</dl><h3>Agents</h3>${runs}${changes.length === 0 ? "" : html`<h3>Changes</h3>${changes}`}</section>`;
  });
  const result = pack.result;
  const outcome = result === null ? html`<section><h2>Result</h2><p class="meta">No finished result yet.</p></section>` :
    joinHtml([html`<section data-evidence-result><h2>Result</h2><dl>`,
    html`<dt>Checks</dt><dd>${result.checks.detail}${result.checks.command ? html` <code>${result.checks.command}</code>` : ""}</dd>`,
    html`<dt>Marked complete</dt><dd>${result.completedBy === null ? "Not yet" : html`${result.completedBy} · ${when(result.completedAt)}`}</dd>`,
    html`<dt>Published</dt><dd>${result.publication === null ? "Not published" : html`${result.publication.state}${result.publication.prUrl ? html` · ${link(result.publication.prUrl)}` : ""}${result.publication.remoteState ? html` · ${result.publication.remoteState.toLowerCase()}` : ""}`}</dd>`,
    html`<dt>Commit</dt><dd>${short(result.base)} → ${short(result.head)}</dd>`,
    result.caveats.length ? html`<dt>Caveats</dt><dd>${joinHtml(result.caveats, html`<br>`)}</dd>` : "",
    html`</dl></section>`]);
  const decisions = pack.ledger.entries.filter(one => one.source !== "request");
  const requests = pack.ledger.entries.length - decisions.length;
  const askedWords = `${requests} ${requests === 1 ? "request" : "requests"} made through the console (accepted or refused)`;
  const ledger = html`<section><h2>Ledger</h2>${decisions.length === 0 ? html`<p class="meta">No entries.</p>` :
    html`<div class="evidence-table"><table><thead><tr><th>#</th><th>Time</th><th>Who</th><th>What</th><th>Outcome</th><th>Seal</th></tr></thead><tbody>${
    decisions.map(one => html`<tr data-ledger-id="${one.id}"><td>${one.id}</td><td>${when(one.at)}</td><td>${one.actor}</td><td>${one.action}${one.detail ? html`<br><span class="meta">${one.detail}</span>` : ""}</td><td>${one.outcome}</td><td>${short(one.seal?.hash ?? null)}</td></tr>`)
    }</tbody></table></div>`}${requests > 0 ? html`<p class="meta">Plus ${askedWords}, listed in the JSON.</p>` : ""}${pack.ledger.truncated ? html`<p class="meta">This pack holds ${decisions.length} of the task's entries and the newest ${requests} requests; the ledger export has the rest.</p>` : ""}</section>`;
  const cost = pack.totals.runs === 0 ? "None ran" : `${pack.totals.runs} ${pack.totals.runs === 1 ? "run" : "runs"} · ${usd(pack.totals.costUsd)}`;
  // The rules as they stand, and each change to them (the approval above was under whichever applied then).
  const rules = pack.rules === null ? html`None` : html`${pack.rules.now}${pack.rules.changes.length === 0 ? "" :
    html`<ul class="criteria">${pack.rules.changes.slice(-5).map(one => html`<li class="meta">${when(one.at)} · ${one.by}: ${one.change}</li>`)}</ul>`}`;
  return joinHtml([html`<article class="evidence-pack" data-evidence-pack="${task.id}">`,
    html`<div class="evidence-head"><h1>Evidence pack</h1><p class="evidence-actions"><a href="/t/${encodeURIComponent(task.id)}/evidence?format=json" download>Download JSON</a> · <a href="/t/${encodeURIComponent(task.id)}">Back to task</a></p></div>`,
    html`<p><strong>${task.title}</strong></p>`,
    html`<dl><dt>Task</dt><dd>${task.id}${task.project === null ? "" : ` · ${task.project}`} · ${task.state}</dd>`,
    html`<dt>Approval rules</dt><dd>${rules}</dd><dt>Agents</dt><dd>${cost}</dd>`,
    html`<dt>Prepared</dt><dd>${when(pack.generatedAt)} for ${pack.generatedBy}</dd></dl>${chain}`,
    versions, outcome, ledger,
    html`<p class="evidence-foot">Pack digest <code>${pack.digest}</code>. Each ledger entry's seal can be rechecked from the JSON: ${pack.ledger.recipe}.</p></article>`]);
}

/** The page as a file on its own (the CLI's --html): the same facts with just enough style to print. */
export function standaloneEvidenceHtml(pack: EvidencePack): string {
  const css = `:root{--muted-foreground:#5c5c5c;--border:#dedede;--success:#1a7f37;--font-mono:ui-monospace,SFMono-Regular,Menlo,monospace}` +
    `body{font:14px/1.5 system-ui,-apple-system,sans-serif;margin:32px auto;padding:0 16px;max-width:960px;color:#171717;background:#fff}.meta{color:var(--muted-foreground);font-size:.8125rem}.evidence-actions{display:none}` +
    EVIDENCE_PACK_CSS;
  // The file is the sink: its bytes.
  return htmlString(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Evidence pack · ${pack.task.id}</title>${styleElement(css)}</head><body>${evidencePackHtml(pack)}</body></html>
`);
}
