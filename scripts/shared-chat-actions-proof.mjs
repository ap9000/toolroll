/** Synthetic desktop and phone journey. No live database, model or chat messages. */
import {
  existsSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { startFixture } from "./ui-polish-fixture.mjs";
import { prepareSharedAction } from "../dist/chat-actions.js";
import { assignmentOf } from "../dist/assignment.js";
import { verifyApproverStanding } from "../dist/principal.js";
import { subscriptionCredentialKey } from "../dist/converse.js";
import { knowledgeView } from "../dist/project-knowledge.js";
import { release } from "../dist/claim.js";
import { telegramProgressCard } from "../dist/telegram-progress.js";
import { presetTerms, modeTermsJson, modeDigestOf } from "../dist/modes.js";
const out = resolve("output/playwright/shared-chat-actions");
mkdirSync(out, { recursive: true });
let pw;
const modules = [process.env.PLAYWRIGHT_MODULE].filter(Boolean),
  cache = join(homedir(), ".npm", "_npx");
if (existsSync(cache))
  for (const d of readdirSync(cache))
    modules.push(join(cache, d, "node_modules/playwright/index.mjs"));
for (const p of modules)
  if (existsSync(p)) {
    pw = await import(pathToFileURL(p));
    break;
  }
if (!pw) throw Error("Playwright unavailable");
const browser = await pw.chromium.launch({ channel: "chrome" }),
  report = { synthetic: true, checks: [], screenshots: [], source: {} };
for (const file of [
  "src/chat-actions.ts",
  "src/lead-doors.ts",
  "src/lead-tools.ts",
  "src/serve.ts",
  "src/telegram-lead.ts",
  "src/store.ts",
  "src/telegram-progress.ts",
  "src/telegram.ts",
])
  report.source[file] = createHash("sha256")
    .update(readFileSync(file))
    .digest("hex");
function check(name, ok, detail) {
  report.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "ok" : "FAIL"} ${name}`);
  if (!ok) throw Error(name);
}
async function shot(page, name) {
  await settled(page);
  const path = join(out, name + ".png");
  await page.screenshot({ path });
  report.screenshots.push(path);
}
async function fits(page, name) {
  await settled(page);
  const shape = await page.evaluate(() => ({
    viewport: innerWidth,
    width: document.documentElement.scrollWidth,
    buttons: [
      ...document.querySelectorAll(".shared-action button,.shared-action .arm"),
    ]
      .filter((e) => e.checkVisibility())
      .map((e) => {
        const r = e.getBoundingClientRect();
        return {
          label: e.textContent.trim(),
          height: r.height,
          width: r.width,
          scroll: e.scrollWidth,
        };
      }),
  }));
  check(
    name,
    shape.width <= shape.viewport &&
      shape.buttons.every((b) => b.height >= 44 && b.scroll <= b.width + 1),
    shape,
  );
}
async function settled(page) {
  await page.waitForLoadState("load");
  await page.waitForFunction(() => {
    try {
      return !document.documentElement.matches(":active-view-transition");
    } catch {
      return true;
    }
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}
async function click(page, locator) {
  await settled(page);
  await locator.click();
  await settled(page);
}
try {
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ]) {
    const f = await startFixture({ sameTaskRevisions: true, secondProject: true, assignmentPresentation: true }),
      store = f.store,
      root = join(f.repos.main, "..", "evidence");
    const context = await browser.newContext({
        viewport,
        isMobile: name === "phone",
        hasTouch: name === "phone",
        reducedMotion: "reduce",
      }),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    function proposal(operation, input) {
      const now = new Date(),
        verified = verifyApproverStanding(
          store,
          f.name,
          store.accountOf(f.name).generation,
          Object.values(f.repos).filter(Boolean),
        );
      if (!verified.ok) throw Error("principal");
      const who = verified.who,
        credentialKey = subscriptionCredentialKey("codex-subscription");
      let session = store.activeLeadSession(f.name);
      if (!session) {
        store.mintLeadSession(
          {
            approver: f.name,
            approverGeneration: who.generation,
            credentialKey,
            ceilingMicrousd: 0,
            ceilingDigest: who.ceilingDigest,
            termsDigest: "synthetic",
          },
          now,
        );
        session = store.activeLeadSession(f.name);
      }
      const thread = store.openLeadThread(f.name, who.ceilingDigest, now).thread
          .id,
        turn = store.openLeadTurn(
          {
            approver: f.name,
            session: session.id,
            thread,
            credentialKey,
            reservedMicrousd: 0,
            dailyTurns: 50,
            weeklyCeilingMicrousd: 0,
            deadlineMs: 60000,
          },
          now,
        );
      if (!turn.ok) throw Error(turn.reason);
      const started = store.startLeadTurn(turn.id, now);
      const action = prepareSharedAction(
          store,
          who,
          operation,
          input,
          root,
          now,
        ),
        id = store.draftLeadProposal(
          {
            thread,
            turn: turn.id,
            kind: "action",
            payload: action,
            ceilingDigest: who.ceilingDigest,
          },
          now,
        );
      store.finalizeLeadTurn(
        turn.id,
        started.generation,
        {
          state: "answered",
          settledMicrousd: 0,
          tokensIn: 0,
          tokensOut: 0,
          message: {
            text: "Synthetic review example. Check the proposed action below.",
            activity: "",
          },
        },
        now,
      );
      return id;
    }
    try {
      await page.goto(f.url + "/login");
      await page.locator("[name=name]").fill(f.name);
      await page.locator("[name=token]").fill(f.password);
      await click(
        page,
        page.getByRole("button", { name: "sign in", exact: true }),
      );
      const action = proposal("result_accept", {
        task: f.tasks.done,
        run: f.runId,
      });
      await page.goto(f.url + "/chat");
      await page
        .getByRole("link", { name: "Review action", exact: true })
        .waitFor();
      await page
        .getByRole("link", { name: "Review action", exact: true })
        .scrollIntoViewIfNeeded();
      await shot(page, name + "-proposal");
      await click(
        page,
        page.getByRole("link", { name: "Review action", exact: true }),
      );
      await fits(page, name + " complete review fits");
      await shot(page, name + "-review");
      const text = await page.locator("main").innerText();
      check(
        name + " exact result and human acceptance terms",
        text.includes("Result #" + f.runId) &&
          text.includes(
            "Machine checks and reviewer findings remain unchanged.",
          ) &&
          text.includes("Live channel behavior is still untested."),
      );
      if (name === "desktop") {
        await page.locator("[name=confirm]").focus();
        await page.keyboard.press("Space");
        check(
          name + " keyboard confirmation",
          await page.locator("[name=confirm]").isChecked(),
        );
      } else await page.locator("[name=confirm]").check();
      await page
        .getByRole("button", { name: "Accept and finish", exact: true })
        .scrollIntoViewIfNeeded();
      await shot(page, name + "-confirm");
      await click(
        page,
        page.getByRole("button", { name: "Accept and finish", exact: true }),
      );
      await page
        .getByText(
          "Accepted and finished. The recorded checks are unchanged.",
          { exact: true },
        )
        .waitFor();
      check(
        name + " shared receipt records actual completion",
        store.getLeadProposal(action)?.state === "confirmed" &&
          assignmentOf(store, f.tasks.done, new Date(), { principal: "operator", repos: null, includeUnplaced: true })?.state === "complete",
      );
      await shot(page, name + "-receipt");
      await page.goto(f.url + `/chat?task=${f.tasks.done}&result=${f.runId}`);
      await page.locator("#comment-form [name=note]").waitFor();
      await page
        .locator("#comment-form [name=note]")
        .fill(
          "Please name the rounding helper so the intent is clear when reviewing the changes.",
        );
      await click(
        page,
        page.locator("#comment-form button[data-request-changes]"),
      );
      check(
        name + " result feedback creates one unapproved revision",
        store.revisionsFromRun(f.runId).length === 1 &&
          store.getScope(store.revisionsFromRun(f.runId)[0].id)
            ?.approvedDigest === null,
      );
      await shot(page, name + "-revision");
      const instructions =
        "Keep task updates short. Say what finished, what remains, and the next action. ".repeat(
          32,
        ) +
        "\nLong reference: " +
        "acceptance-".repeat(30);
      const long = proposal("knowledge_instructions", {
        repo: f.repos.main,
        instructions,
      });
      await page.goto(f.url + `/chat/action/${long}`);
      await fits(page, name + " long review fits");
      check(
        name + " full long instructions remain visible",
        (await page.locator("main").innerText()).includes(instructions),
      );
      await shot(page, name + "-long-review");
      await page.locator("[name=confirm]").check();
      await click(
        page,
        page.getByRole("button", {
          name: "Save project instructions",
          exact: true,
        }),
      );
      check(
        name + " chat change appears in project knowledge",
        knowledgeView(store, f.repos.main, f.name).knowledge.instructions ===
          instructions,
      );
      const hiddenInstructions =
        "Use /Users/operator/project/reference.md as the synthetic reference.";
      const hidden = proposal("knowledge_instructions", {
        repo: f.repos.main,
        instructions: hiddenInstructions,
      });
      await page.goto(f.url + `/chat/action/${hidden}`);
      check(
        name + " redacted chat details are complete in secure review",
        (await page.locator("main").innerText()).includes(hiddenInstructions),
      );
      await fits(page, name + " redacted preview review fits");
      await shot(page, name + "-redacted-review");
      const stale = proposal("knowledge_instructions", {
        repo: f.repos.main,
        instructions: "Newer draft for this synthetic example.",
      });
      const pageBefore = await page.goto(f.url + `/chat/action/${stale}`);
      check(name + " pending review is available", pageBefore.status() === 200);
      // This source changes through its existing service after the screen was read.
      const { changeKnowledge } = await import("../dist/project-knowledge.js"),
        view = knowledgeView(store, f.repos.main, f.name);
      changeKnowledge(
        store,
        {
          repo: f.repos.main,
          actor: f.name,
          identity: view.identity,
          revision: view.revision,
          action: "instructions",
          draft: { instructions: "Saved in another window." },
        },
        new Date(),
      );
      await page.locator("[name=confirm]").check();
      await click(
        page,
        page.getByRole("button", {
          name: "Save project instructions",
          exact: true,
        }),
      );
      check(
        name + " stale action names the error without overwriting",
        (await page.locator("main").innerText()).includes(
          "This action changed.",
        ) &&
          knowledgeView(store, f.repos.main, f.name).knowledge.instructions ===
            "Saved in another window.",
      );
      await fits(page, name + " error fits");
      await shot(page, name + "-stale");
      await page.goto(f.url + "/chat/action/999999");
      check(
        name + " missing action is clear",
        (await page.locator("main").innerText()).includes("no longer waiting"),
      );
      await fits(page, name + " unavailable action fits");
      check(name + " browser errors", errors.length === 0, errors);
      // These are previews of the exact outbound text and bold ranges, not
      // screenshots of the Telegram app or a claim of physical-phone testing.
      const at = new Date(), failedRun = f.statusRuns.running;
      store.recordOutcomeFacts(failedRun, { handoff: "could not re-read the branch in /Users/example/private/project" });
      store.finishRun(failedRun, { outcome: "failed", reason: "retryable-infra", now: at });
      release(store, store.getRun(failedRun).leaseId, at);
      store.setTaskState(f.statusTasks.running, "queued", at);
      store.holdOwned({ taskRef: store.getRun(failedRun).taskRef, ownerKind: "operator", ownerId: "preview", reason: "Restore the worker’s folder access before retrying.", until: null }, at);
      const terms = presetTerms("hands-off", new Date(at.getTime() + 86400000).toISOString());
      store.signMode({ repo: f.repos.main, name: "hands-off", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: f.name, absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, at);
      // Give the reviewing example passing machine checks; the unrelated
      // stock fixture deliberately starts with incomplete evidence.
      const reviewProof = store.proofVerdictFor(f.statusRuns.reviewing);
      store.saveProofVerdict(f.statusRuns.reviewing, "verified", [], at, reviewProof.matrix.map(row => ({ ...row, state: "pass", detail: [], coverage: undefined, review: null })));
      const cards = [
        ["Blocked", failedRun, f.statusTasks.running],
        ["Review", f.statusRuns.reviewing, f.statusTasks.reviewing],
        ["Missing evidence", f.statusRuns.missingProof, f.statusTasks.missingProof],
        ["Merged", f.statusRuns.merged, f.statusTasks.merged],
      ].map(([state, id, task]) => ({ state, ...telegramProgressCard(store, store.getRun(id), task, f.repos.main, at) }));
      const escape = text => text.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
      const formatted = card => {
        let cursor = 0, html = "";
        for (const entity of card.entities) {
          html += escape(card.text.slice(cursor, entity.offset)) + "<strong>" + escape(card.text.slice(entity.offset, entity.offset + entity.length)) + "</strong>";
          cursor = entity.offset + entity.length;
        }
        return html + escape(card.text.slice(cursor));
      };
      const renderCards = list => `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Telegram message previews</title><style>
        *{box-sizing:border-box}body{margin:0;padding:24px;background:#101820;color:#f7f9fb;font:16px/1.48 system-ui,-apple-system,sans-serif}h1{font-size:20px;margin:0 0 4px}p{color:#aab9c9;margin:0 0 24px;font-size:13px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:20px;align-items:start}.card{background:#223345;border-radius:18px;overflow:hidden;min-width:0}.content{padding:18px;white-space:pre-wrap;overflow-wrap:anywhere}strong{font-weight:700}.action{display:block;min-height:48px;padding:12px 16px;border-top:1px solid #43556a;text-align:center;color:#b9e0ff;text-decoration:none;font-weight:600;white-space:nowrap}.action:focus-visible{outline:3px solid #71c6ff;outline-offset:-4px}.state{font-size:12px;color:#aab9c9;margin:0 0 6px}@media(max-width:500px){body{padding:18px 12px}.grid{gap:20px}.content{padding:16px}}
        </style><h1>Telegram status previews</h1><p>Synthetic examples · Exact message text and formatting, outside Telegram.</p><div class="grid">${list.map(card => `<section><div class="state">${escape(card.state)}</div><article class="card"><div class="content">${formatted(card)}</div><a class="action" href="${escape(f.url + card.link.path)}">${escape(card.link.label)}</a></article></section>`).join("")}</div></html>`;
      await page.goto("about:blank");
      await page.setContent(renderCards(cards));
      const cardShape = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth, actions: [...document.querySelectorAll(".action")].map(a => ({ height: a.getBoundingClientRect().height, width: a.clientWidth, content: a.scrollWidth })) }));
      check(name + " Telegram cards fit with comfortable single-line actions", cardShape.content <= cardShape.width && cardShape.actions.every(a => a.height >= 44 && a.content <= a.width), cardShape);
      check(name + " Telegram blocker omits internal paths and has one next step", cards[0].text.includes("Worker needs project access") && !cards[0].text.includes("/Users/") && cards[0].link.label === "Review hold");
      await page.keyboard.press("Tab");
      check(name + " Telegram preview keyboard reaches its action", await page.locator(".action").first().evaluate(a => a === document.activeElement));
      await shot(page, name + "-telegram-status");
      await click(page, page.getByRole("link", { name: "Review hold", exact: true }));
      if (new URL(page.url()).pathname === "/login") {
        await page.locator("[name=name]").fill(f.name);
        await page.locator("[name=token]").fill(f.password);
        await click(page, page.getByRole("button", {name:"sign in",exact:true}));
      }
      check(name + " Telegram hold action opens real recovery controls", new URL(page.url()).pathname === `/t/${f.statusTasks.running}` && (await page.locator("main").innerText()).includes("Restore the worker"), {path:new URL(page.url()).pathname});
      await page.goto("about:blank");
      await page.setContent(renderCards([cards[2]]));
      await shot(page, name + "-telegram-missing");
    } finally {
      await context.close();
      await f.stop();
    }
  }
} finally {
  writeFileSync(
    join(out, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser.close();
}
