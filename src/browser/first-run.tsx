/** The first run in Chat: three plain steps to a first result, how it works
 * (once, above the composer) with first tasks to try, and, after the first
 * Ready result, the phone. A suggestion only drafts words in the composer;
 * nothing is filed until the person sends it and confirms the lead's
 * proposal. */
import { useContext, useEffect, useState } from "react";
import type { BrowserFirstRun, BrowserPhoneCard } from "../browser-workspace.js";
import type { JourneyStep } from "../first-run.js";
import { Frame, FrameHeader, FramePanel } from "./components/ui/frame.js";
import { StatusGlyph, type GlyphKind } from "./components/ui/status-glyph.js";
import { Button } from "./components/ui/button.js";
import { FormToken, PostForm } from "./ui/index.js";

function Command({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(command).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }, () => {}); };
  return <span className="so-first-run-command"><code>{command}</code>
    <Button className="max-[901px]:h-11 max-[901px]:min-h-11" variant="ghost" size="sm" onClick={copy} aria-label={`Copy ${command}`}>{copied ? "Copied" : "Copy"}</Button></span>;
}

/** What the composer holds after a first task is tapped: the task, added after anything the person already typed, never
 * in place of it. */
export function withSuggestion(typed: string, suggestion: string): string {
  if (typed.trim() === "") return suggestion;
  if (typed.includes(suggestion)) return typed;
  return `${typed.trimEnd()}\n${suggestion}`;
}

/** Whether a sign-in check's answer means the page should show the new state: the lead turned on, or an agent signed in. */
export function rechecked(answer: unknown): boolean {
  if (typeof answer !== "object" || answer === null) return false;
  const body = answer as { lead?: unknown; agent?: unknown };
  return body.lead === "on" || body.agent === true;
}

/** How long a started navigation keeps this page from reloading itself: a navigation that is still pending after this
 * was cancelled or answered without leaving (Stay on a confirm prompt, a 204), and the page is the person's again. */
export const LEAVING_HOLD_MS = 15_000;
const LEAVING_EVENT = "so:leaving";
/** A script's own navigation (a select that opens a project, a form handled in place): say so first, then go, so a
 * page reloading itself on its own (useRecheck) never bounces the person back where beforeunload never fires. */
export function leaveFor(href: string): void {
  window.dispatchEvent(new Event(LEAVING_EVENT));
  window.location.assign(href);
}

/**
 * While no agent is signed in, ask this computer again every few seconds and show the new state once one is. Once the
 * person has started leaving (a same-tab link, a form, Settings → Lead, a typed address), the page is not reloaded out
 * from under them: the page they asked for may itself wait on the same sign-in check, and a reload here would bounce
 * them back. Links and forms are seen directly (iOS Safari never fires beforeunload); the hold lapses on its own, so a
 * navigation that never happened only delays the reload. A page restored from the back/forward cache is theirs again.
 */
function useRecheck(href: string | null | undefined) {
  // A check is a POST with the page's form token: a page visit never sets one off (docs/plans/get-side-effects.md).
  const csrf = useContext(FormToken);
  useEffect(() => {
    if (!href) return;
    let stopped = false;
    let leftAt: number | null = null;
    let timer = 0;
    const leaving = () => leftAt !== null && Date.now() - leftAt < LEAVING_HOLD_MS;
    const later = (ms: number) => { window.clearTimeout(timer); if (!stopped) timer = window.setTimeout(() => { void ask(); }, ms); };
    const ask = async () => {
      try {
        const answer = await fetch(href, { method: "POST", headers: { accept: "application/json" }, body: new URLSearchParams({ csrf }), cache: "no-store" });
        const on = answer.ok && rechecked(await answer.json());
        if (stopped) return;
        // On, and the person is on their way elsewhere: ask again once the hold lapses (the new page, when it comes, ends this).
        if (on && !leaving()) { window.location.reload(); return; }
        if (on) { later(LEAVING_HOLD_MS - (Date.now() - leftAt!) + 100); return; }
      } catch { /* Offline or restarting: ask again shortly. */ }
      later(5000);
    };
    const leave = () => { leftAt = Date.now(); };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (link === null || (link.getAttribute("target") ?? "_self") !== "_self" || link.hasAttribute("download")) return;
      // A link within this page (Skip to content, #latest) moves the view, not the page.
      let to: URL; try { to = new URL(link.getAttribute("href")!, window.location.href); } catch { return; }
      if (to.hash !== "" && to.origin === window.location.origin && to.pathname === window.location.pathname && to.search === window.location.search) return;
      leave();
    };
    const onSubmit = (event: SubmitEvent) => { if (!event.defaultPrevented) leave(); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) { leftAt = null; later(3000); } };
    window.addEventListener("beforeunload", leave);
    window.addEventListener("click", onClick);
    window.addEventListener("submit", onSubmit);
    window.addEventListener("pageshow", restored);
    window.addEventListener(LEAVING_EVENT, leave);
    later(3000);
    return () => {
      stopped = true; window.clearTimeout(timer);
      window.removeEventListener("beforeunload", leave); window.removeEventListener("click", onClick);
      window.removeEventListener("submit", onSubmit); window.removeEventListener("pageshow", restored);
      window.removeEventListener(LEAVING_EVENT, leave);
    };
  }, [href, csrf]);
}

export function FirstRun({ firstRun }: { firstRun: BrowserFirstRun }) {
  useRecheck(firstRun.recheck);
  const waiting = firstRun.recheck != null;
  return <section className="so-first-run" aria-labelledby="first-run-title" data-first-run>
    <h2 id="first-run-title">Get to your first result</h2>
    <ol className="so-first-run-steps">
      {firstRun.steps.map(step => <li key={step.key} data-step={step.key} data-done={step.done}>
        <span className="so-first-run-mark" aria-hidden="true">{step.done ? "✓" : ""}</span>
        <span className="so-first-run-title">{step.title}<span className="so-sr-only">{step.done ? ": done" : step.checking ? ": checking" : ": not yet"}</span></span>
        {step.checking && <span className="so-first-run-checking" aria-hidden="true">Checking…</span>}
        {step.action !== null && (step.key === "agent" && firstRun.sandbox !== null ? null
          : step.action.kind === "link" ? <Button className="max-[901px]:h-11 max-[901px]:min-h-11" asChild variant="outline" size="sm"><a href={step.action.href}>{step.action.label}</a></Button>
          : <Command command={step.action.command} />)}
        {step.key === "agent" && !step.done && firstRun.sandbox !== null && step.action?.kind === "command" && <div className="so-first-run-choices" data-first-run-choices>
          <div data-sign-in-command><p className="so-first-run-choice-title">Sign in an agent</p><p className="so-first-run-choice-hint">Run this on this computer. Chat turns on by itself once you’re signed in.</p><Command command={step.action.command} /></div>
          <div><p className="so-first-run-choice-title">Or try the sandbox</p><p className="so-first-run-choice-hint">Sample tasks, no spend.</p><Command command={firstRun.sandbox} /></div>
        </div>}
      </li>)}
    </ol>
    {waiting && <p className="so-first-run-recheck" role="status" data-first-run-recheck><span className="so-live-dot" aria-hidden="true" />Checking for a signed-in agent</p>}
  </section>;
}

/** Above the composer until the first request: how it works in one sentence, three first tasks, and what runs the lead. */
export function FirstRequest({ firstRun, onDraft }: { firstRun: BrowserFirstRun; onDraft: (text: string) => void }) {
  return <div className="so-first-request" data-first-request>
    {firstRun.intro && <p className="so-first-request-intro" data-how-it-works>{firstRun.intro}</p>}
    {firstRun.suggestions.length > 0 && <div className="so-suggestions so-first-request-suggestions" aria-label="First tasks to try" data-first-tasks>
      {firstRun.suggestions.map(one => <Button key={one.draft} variant="outline" size="sm" className="so-suggestion h-auto min-h-[30px] whitespace-normal py-1.5 text-left max-[901px]:min-h-11 phone:h-auto" data-source={one.source} onClick={() => onDraft(one.draft)}>{one.label}</Button>)}
    </div>}
    {firstRun.lead && <p className="so-first-request-lead" data-lead-line>{firstRun.lead.words} · <a href={firstRun.lead.href}>Change</a></p>}
  </div>;
}

/** The same work from the phone (Settings → Chat apps). `dismissable`: offer Not now, which puts away chat's pointer to it. */
export function PhoneCard({ phone, csrf, dismissable = true }: { phone: BrowserPhoneCard; csrf: string; dismissable?: boolean }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  const [first, ...others] = phone.chatApps;
  // One Frame like the Settings groups around it: the heading on the well, each way to reach it a paper panel.
  return <section aria-labelledby="phone-card-title" data-phone-card className="so-phone-card"><Frame>
    <FrameHeader><h2 id="phone-card-title" className="text-sm font-semibold">Use it from your phone</h2></FrameHeader>
    <div className="so-phone-options">
      <FramePanel>
        <p className="so-first-run-choice-title">A chat app</p>
        <p className="so-first-run-choice-hint">Get results and approve plans in {first?.label ?? "Telegram"}: add the bot, then pair your phone.</p>
        {first && <Button className="max-[901px]:h-11 max-[901px]:min-h-11" asChild variant="outline" size="sm"><a href={first.href}>Pair {first.label}</a></Button>}
        {others.length > 0 && <p className="so-phone-others">Or {others.map((one, index) => <span key={one.href}>{index > 0 && (index === others.length - 1 ? " or " : ", ")}<a href={one.href}>{one.label}</a></span>)}</p>}
      </FramePanel>
      <FramePanel data-phone-tailnet>
        <p className="so-first-run-choice-title">This console over Tailscale</p>
        {phone.tailnet === null
          ? <p className="so-first-run-choice-hint">Install <a href="https://tailscale.com/download">Tailscale</a> on this computer and your phone, then reload this page for the address.</p>
          : phone.tailnet.restart === null
            ? <><p className="so-first-run-choice-hint">On your phone, open this and sign in:</p><Command command={phone.tailnet.address} /></>
            : <><p className="so-first-run-choice-hint">Start Toolroll with this, then on your phone open <code>{phone.tailnet.address}</code> and sign in:</p><Command command={phone.tailnet.restart} /></>}
      </FramePanel>
    </div>
    {dismissable && <PostForm action={phone.dismissHref} className="px-1.5 pb-0.5" onSubmit={event => {
      event.preventDefault();
      setHidden(true);
      void fetch(phone.dismissHref, { method: "POST", body: new URLSearchParams({ csrf, quiet: "1" }) }).catch(() => {});
    }}><Button className="max-[901px]:h-11 max-[901px]:min-h-11" variant="ghost" size="sm" type="submit">Not now</Button></PostForm>}
  </Frame></section>;
}

/** A task's road to Ready (after ReUI's Stepper, read-only): Plan → You approve → Build → Checks → Ready, filled in as it
 * moves. Each step's mark is the shared status glyph: done is green, the step at work blue, the step that waits on a
 * person amber (the only amber), a failure vermilion, a skipped or future step a dashed ring. The words carry it. */
const ROAD_GLYPH = (step: JourneyStep): { kind: GlyphKind; className?: string } =>
  step.state === "done" ? { kind: "done" }
  : step.needsYou === true ? { kind: "decide", className: "text-warning" }
  : step.state === "current" ? { kind: "building" }
  : step.state === "stuck" ? { kind: "failed" }
  : { kind: "idle" };
const ROAD_WORD: Record<JourneyStep["state"], string> = { done: "done", current: "now", stuck: "stopped here", skipped: "skipped", todo: "next" };
export function Journey({ steps }: { steps: JourneyStep[] }) {
  const current = steps.find(one => one.state === "current" || one.state === "stuck");
  const where = current !== undefined ? `${current.label}${current.needsYou ? ", waits on you" : current.state === "stuck" ? ", stopped here" : ""}` : (steps.every(one => one.state === "done" || one.state === "skipped") ? "Ready" : [...steps].reverse().find(one => one.state !== "todo")?.label ?? steps[0]?.label ?? "");
  return <ol role="list" className="first-task-journey" aria-label={`Where this task is: ${where}`} data-first-task-journey style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
    {steps.map(one => { const glyph = ROAD_GLYPH(one); return <li key={one.key} data-step={one.key} data-state={one.state} {...(one.needsYou ? { "data-needs-you": "" } : {})} aria-current={one.state === "current" || one.state === "stuck" ? "step" : undefined}>
      <span className="first-task-journey-mark" aria-hidden="true"><StatusGlyph kind={glyph.kind} {...(glyph.className === undefined ? {} : { className: glyph.className })} /></span>
      <span>{one.label}<span className="sr-only">{`, ${one.needsYou ? "waits on you" : ROAD_WORD[one.state]}`}</span></span>
    </li>; })}
  </ol>;
}
