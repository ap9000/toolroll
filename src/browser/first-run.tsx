/** The first run in Chat: three plain steps to a first result, how it works
 * (once, above the composer) with first tasks to try, and, after the first
 * Ready result, the phone. A suggestion only drafts words in the composer;
 * nothing is filed until the person sends it and confirms the lead's
 * proposal. */
import { useEffect, useState } from "react";
import type { BrowserFirstRun, BrowserPhoneCard } from "../browser-workspace.js";
import type { JourneyStep } from "../first-run.js";
import { Frame, FrameHeader, FramePanel } from "./components/ui/frame.js";
import { Button } from "./components/ui/button.js";
import { PostForm } from "./ui/index.js";

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

/** While no agent is signed in, ask this computer again every few seconds and show the new state once one is. */
function useRecheck(href: string | null | undefined) {
  useEffect(() => {
    if (!href) return;
    let stopped = false;
    let timer = 0;
    const ask = async () => {
      try {
        const answer = await fetch(href, { headers: { accept: "application/json" }, cache: "no-store" });
        if (answer.ok && rechecked(await answer.json())) { window.location.reload(); return; }
      } catch { /* Offline or restarting: ask again shortly. */ }
      if (!stopped) timer = window.setTimeout(() => { void ask(); }, 5000);
    };
    timer = window.setTimeout(() => { void ask(); }, 3000);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [href]);
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

/** The first task's way to Ready: Plan → You approve → Build → Checks → Ready, filled in as it moves. */
export function Journey({ steps }: { steps: JourneyStep[] }) {
  const current = steps.find(one => one.state === "current" || one.state === "stuck");
  return <ol className="first-task-journey" aria-label={`Where this task is: ${current?.label ?? "Ready"}`} data-first-task-journey>
    {steps.map(one => <li key={one.key} data-step={one.key} data-state={one.state} aria-current={one.state === "current" || one.state === "stuck" ? "step" : undefined}>
      <span className="first-task-journey-mark" aria-hidden="true" /><span>{one.label}</span>
    </li>)}
  </ol>;
}
