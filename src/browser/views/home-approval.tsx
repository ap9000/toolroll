/**
 * Home's own approval (docs/plans/live-pages-and-home.md B2.1-B2.4), written for Home: not the task page's open step
 * and not KApprove (which can open a password dialog). It renders only the plan, the terms line, one Approve button and
 * one link, and never a password field.
 *
 * The selected task is read as data with `x-toolroll-read: prefetch` (nothing minted, the session not extended) into
 * one pinned snapshot. Every read carries a generation; a late or older one is dropped. A newer read of the same task
 * whose digest moved redraws the plan and says so, and Approve takes no press for REDRAW_HOLD_MS after any redraw.
 *
 * Approve is offered only when the rules ask for no password, the page is not a password page and the plan sheet holds
 * no form control. Anything else is the plan and one link, Review the plan, which loads the task page as its own
 * document (`data-full-load`): the password is asked there.
 *
 * A press mints for exactly what is shown (a header-less read; a moved digest posts nothing), then posts in place
 * (src/browser/act.ts). A lost answer is never called a failure: Home reads the task again and says what it now says.
 */
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BrowserHomeRow, BrowserWorkspace } from "../../browser-workspace.js";
import { mintedNonce, mintRead, offersApprove, postInPlace, REDRAW_HOLD_MS, selectionRead, sentence, snapshotOf, taskViewOf, type ApprovalSnapshot } from "../act.js";
import { GuardedHtml } from "../guarded-html.js";
import { KButton, KChip, KLinkButton } from "../kit/index.js";
import { isPhone } from "../kit/behavior.js";
import { FormToken } from "../ui/index.js";

/** A selection read waits this long after the last move, so arrowing down a long list reads only where it stops. */
export const SELECTION_SETTLE_MS = 150;

/** The task's chat, where changes to a plan are asked for. */
export const taskChatHref = (taskId: string): string => `/chat?task=${encodeURIComponent(taskId)}`;

type Shown = { phase: "reading" } | { phase: "shown"; snapshot: ApprovalSnapshot | null; sensitive: boolean } | { phase: "unread" };
type Said = { tone: "refused" | "words" | "checking"; text: string } | null;

export function HomeApproval({ row, onApproved, onChanged }: {
  row: BrowserHomeRow;
  /** The approval was kept: Home takes the row out and selects the next one. */
  onApproved: (id: string) => void;
  /** Something changed that Home's own list should show (a vote, a refusal's re-read): Home reads itself again. */
  onChanged: () => void;
}) {
  const csrf = useContext(FormToken);
  const [shown, setShown] = useState<Shown>({ phase: "reading" });
  const [changed, setChanged] = useState(false);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState<null | "sending" | "checking">(null);
  const [said, setSaid] = useState<Said>(null);
  const pane = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const pinned = useRef<{ snapshot: ApprovalSnapshot | null; sensitive: boolean }>({ snapshot: null, sensitive: true });
  const pressing = useRef(false);
  const armedRef = useRef(false);
  const holdTimer = useRef<number | undefined>(undefined);
  const href = row.href;

  /** Any redraw of the plan holds Approve for REDRAW_HOLD_MS. */
  const redraw = () => {
    armedRef.current = false; setArmed(false);
    window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => { armedRef.current = true; setArmed(true); }, REDRAW_HOLD_MS);
  };

  /** Take a read of this task as the snapshot on screen (the caller has proved it is the newest for this selection). */
  const accept = (workspace: BrowserWorkspace | null, forceChanged = false) => {
    if (workspace === null) { pinned.current = { snapshot: null, sensitive: true }; setShown({ phase: "unread" }); return; }
    const snapshot = snapshotOf(workspace);
    const before = pinned.current.snapshot;
    if (forceChanged || (before !== null && snapshot !== null && before.taskId === snapshot.taskId && before.digest !== snapshot.digest)) setChanged(true);
    pinned.current = { snapshot, sensitive: workspace.sensitive };
    setShown({ phase: "shown", snapshot, sensitive: workspace.sensitive });
    redraw();
  };

  /** Read the selected task again (a prefetch read: never minted). Resolves once it landed or was dropped. */
  const readAgain = async (): Promise<BrowserWorkspace | null | undefined> => {
    const mine = ++generation.current;
    const workspace = await selectionRead(href);
    if (mine !== generation.current) return undefined;
    accept(workspace);
    return workspace;
  };

  // A new selection: a new snapshot, read once the selection settles. A read for an earlier selection is dropped.
  useEffect(() => {
    const mine = ++generation.current;
    pinned.current = { snapshot: null, sensitive: true };
    pressing.current = false;
    setShown({ phase: "reading" }); setChanged(false); setSaid(null); setBusy(null);
    armedRef.current = false; setArmed(false);
    if (isPhone()) return () => { generation.current++; };
    const timer = window.setTimeout(() => {
      void selectionRead(href).then(workspace => { if (mine === generation.current) accept(workspace); });
    }, SELECTION_SETTLE_MS);
    return () => { window.clearTimeout(timer); generation.current++; };
  }, [href]);
  useEffect(() => () => window.clearTimeout(holdTimer.current), []);

  // Home never shows a password field: checked after every read and every redraw. One found takes the plan off.
  useLayoutEffect(() => {
    if (pane.current?.querySelector('input[type="password"]') && pinned.current.snapshot !== null) {
      pinned.current = { snapshot: null, sensitive: true };
      setShown({ phase: "shown", snapshot: null, sensitive: true });
    }
  });

  const press = async () => {
    const shownNow = pinned.current;
    if (pressing.current || !armedRef.current || !offersApprove(shownNow.snapshot, shownNow.sensitive)) return;
    const snapshot = shownNow.snapshot!;
    pressing.current = true;
    setBusy("sending"); setSaid(null);
    const finish = () => { pressing.current = false; setBusy(null); };
    const mine = ++generation.current;
    // 1. Mint for exactly what is shown.
    const minted = await mintRead(href);
    if (mine !== generation.current) { pressing.current = false; return; }
    const latest = snapshotOf(minted);
    const nonce = mintedNonce(minted);
    if (minted === null) { finish(); setSaid({ tone: "refused", text: "Couldn’t read the plan just now. Nothing changed." }); void readAgain(); return; }
    if (latest === null || nonce === null || latest.taskId !== snapshot.taskId || latest.action !== snapshot.action || latest.digest !== snapshot.digest
      || latest.rebuild !== snapshot.rebuild || !offersApprove(latest, minted.sensitive)) {
      // A newer plan is never approved by the press that found it: nothing is posted, the plan is drawn again.
      finish();
      accept(minted, true);
      return;
    }
    // 2. Post in place: the snapshot's action, digest and rebuild; the nonce just minted; never a password.
    const answer = await postInPlace(snapshot, csrf, nonce);
    if (answer.kind === "elsewhere") { window.location.assign(href); return; }
    if (answer.kind === "answer" && answer.outcome === "approved") { onApproved(row.id); return; }
    if (answer.kind === "answer" && answer.outcome === "refused") {
      setSaid({ tone: "refused", text: `${sentence(answer.words)} Nothing changed.` });
      setBusy("checking");
      // The button takes a press again only once the task was read again (a dropped read means a new selection).
      if (await readAgain() !== undefined) finish();
      return;
    }
    if (answer.kind === "answer") {
      setSaid({ tone: "words", text: sentence(answer.words) });
      finish();
      onChanged();
      void readAgain();
      return;
    }
    // No answer: the approval may have been kept before the answer was lost. Read the task and say what it says.
    setBusy("checking");
    setSaid({ tone: "checking", text: "Checking…" });
    const after = await readAgain();
    if (after === undefined) return;
    const task = taskViewOf(after);
    if (after === null || task === null) { setSaid({ tone: "checking", text: "Couldn’t check yet. Open the task to see where it stands." }); return; }
    if (task.approve == null && task.approved != null) { onApproved(row.id); return; }
    setSaid({ tone: "words", text: task.approve != null ? "Not approved yet: it still waits for your approval." : "It no longer waits for an approval here." });
    finish();
    onChanged();
  };

  const snapshot = shown.phase === "shown" ? shown.snapshot : null;
  const offer = shown.phase === "shown" && offersApprove(snapshot, shown.sensitive);
  return <div ref={pane} className="so-home-approval" data-home-approval={shown.phase === "shown" ? (offer ? "approve" : "review") : shown.phase}>
    <p className="so-open-chip"><KChip word="Needs you" tone="needs" /><span>{snapshot?.heading ?? "Approve a plan"}</span></p>
    {changed && <p className="so-home-changed" role="status" data-home-changed>The plan changed. Read it again.</p>}
    {shown.phase === "reading" && <p className="so-open-x so-home-reading">Reading the plan…</p>}
    {snapshot?.planHtml != null && <GuardedHtml key={snapshot.digest} html={snapshot.planHtml} immutable className="so-home-plan" />}
    {offer && snapshot !== null ? <div className="so-home-do">
      <p className="so-home-terms" data-home-terms>{[snapshot.text, snapshot.termsWords].filter(Boolean).join(" ")}</p>
      <div className="k-acts">
        <KButton variant="primary" label="Approve" busy={busy === "sending" ? "Approving…" : busy === "checking" ? "Checking…" : false}
          aria-disabled={!armed || busy !== null ? true : undefined} data-home-approve="" onClick={() => { void press(); }} />
        <a className="k-link" href={taskChatHref(snapshot.taskId)} data-home-changes="">Request changes</a>
      </div>
    </div> : shown.phase !== "reading" && <div className="k-acts">
      <KLinkButton variant="primary" label="Review the plan" href={href} data-full-load="" data-home-review="" />
    </div>}
    {said && <p className={`so-home-said${said.tone === "refused" ? " is-refused" : ""}`} role="status" data-home-said={said.tone}>{said.text}</p>}
  </div>;
}
