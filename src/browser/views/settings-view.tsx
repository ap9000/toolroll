/** Settings, rebuilt with shadcn/ui. Every control posts to the same server
 * route as before (CSRF included); choices save the moment they change and
 * the server's confirmation arrives as a toast. */
import { Activity, Bot, BookOpen, ChevronRight, Clock, Cpu, Database, Download, FileCheck, Folder, HardDrive, KeyRound, LineChart, Lock, Monitor, Moon, Plug, RefreshCw, ShieldCheck, Sparkles, Sun, Workflow, Wrench } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { BrowserSettingsView } from "../../browser-workspace.js";
import { accentNote, accentTokens, normalHex } from "../../accent-colors.js";
import { digestTimes } from "../../digest-times.js";
import { BrandIcon } from "../brand-mark.js";
import { PhoneCard } from "../first-run.js";
import {
  Badge, Button, Card, CardDescription, CardHeader, CardTitle, Collapsible, CollapsibleContent, CollapsibleTrigger,
  Input, Label, RadioCard, RadioGroup, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Separator, Switch, cn, toast,
} from "../components/ui/index.js";

const TILE_ICONS: Record<string, ReactNode> = {
  "/settings/lead": <Bot />, "/settings/flows": <Workflow />, "/settings/integrations": <Plug />, "/settings/models": <Cpu />, "/settings/skills": <Sparkles />, "/settings/tools": <Wrench />, "/settings/knowledge": <BookOpen />,
  "/settings/learning": <LineChart />,
  "/settings/sign-in": <Lock />, "/settings/sessions": <KeyRound />, "/settings/project": <Folder />, "/settings/policy": <FileCheck />, "/settings/approval": <ShieldCheck />,
  "/settings/monitoring": <Activity />, "/settings/retention": <Clock />, "/settings/storage": <HardDrive />, "/settings/updates": <RefreshCw />, "/settings/backups": <Database />, "/settings/data": <Download />,
};

const slug = (words: string) => words.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function Csrf({ csrf }: { csrf: string }) { return <input type="hidden" name="csrf" value={csrf} />; }

/** A form that submits itself when one of its choices changes. */
function AutoForm({ action, csrf, children, className }: { action: string; csrf: string; children: (submit: () => void) => ReactNode; className?: string }) {
  const form = useRef<HTMLFormElement>(null);
  // Radix writes the hidden value on the next tick; submit after it lands.
  const submit = () => setTimeout(() => form.current?.requestSubmit(), 0);
  return <form ref={form} method="post" action={action} className={className}><Csrf csrf={csrf} />{children(submit)}</form>;
}

function Section({ title, description, children, id }: { title: string; description?: string; children: ReactNode; id?: string }) {
  return <Card id={id} aria-labelledby={id ? `${id}-title` : undefined}>
    <CardHeader><div className="grid gap-1"><CardTitle id={id ? `${id}-title` : undefined}>{title}</CardTitle>{description && <CardDescription>{description}</CardDescription>}</div></CardHeader>
    {children}
  </Card>;
}

function StatusDot({ tone }: { tone: "ok" | "warn" | "off" | "neutral" }) {
  return <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", tone === "ok" && "bg-success", tone === "warn" && "bg-warning", tone === "neutral" && "bg-muted-foreground", tone === "off" && "border-[1.5px] border-muted-foreground")} />;
}

function Themes({ view, csrf }: { view: BrowserSettingsView; csrf: string }) {
  const options = [["system", "Match device", <Monitor key="m" />], ["light", "Light", <Sun key="s" />], ["dark", "Dark", <Moon key="d" />]] as const;
  return <form method="post" action="/settings/appearance" className="flex flex-wrap items-center gap-3">
    <Csrf csrf={csrf} />
    <div role="group" aria-label="Theme" className="inline-flex rounded-lg bg-muted p-0.5">
      {options.map(([value, label, icon]) => <button key={value} type="submit" name="theme" value={value} aria-pressed={view.theme === value}
        className={cn("inline-flex h-7 items-center gap-2 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground phone:h-11 [&_svg]:size-3.5", view.theme === value && "bg-card text-foreground shadow-[var(--so-pill-shadow)]")}>{icon}{label}</button>)}
    </div>
    <span className="text-[13px] text-muted-foreground">Saved in this browser.</span>
  </form>;
}

type Hsv = { h: number; s: number; v: number };
const clamp = (n: number) => Math.min(1, Math.max(0, n));
function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return `#${[f(5), f(3), f(1)].map(x => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`;
}
function hexToHsv(hex: string): Hsv {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: max === 0 ? 0 : d / max, v: max };
}
/** Preview a colour on the whole page at once: the same readable tokens the server will print after it's saved. */
function previewAccent(hex: string) {
  const root = document.documentElement;
  const dark = root.dataset["theme"] === "dark" || (root.dataset["theme"] !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  const tokens = accentTokens(hex)[dark ? "dark" : "light"];
  for (const [name, value] of [["signal", tokens.signal], ["signal-hover", tokens.hover], ["on-signal", tokens.on], ["signal-soft", tokens.soft], ["selection", tokens.selection]]) root.style.setProperty(`--so-${name}`, value!);
}

/** Saturation (across) and brightness (down) for the current hue; drag, or arrow keys (Shift for bigger steps). */
function ColourPlane({ hsv, onChange }: { hsv: Hsv; onChange: (next: Hsv) => void }) {
  const at = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    onChange({ h: hsv.h, s: clamp((event.clientX - box.left) / box.width), v: 1 - clamp((event.clientY - box.top) / box.height) });
  };
  return <div role="slider" tabIndex={0} aria-label="Saturation and brightness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hsv.s * 100)}
    aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
    className="relative h-28 w-44 shrink-0 cursor-crosshair touch-none rounded-lg shadow-[inset_0_0_0_1px_rgb(0_0_0/.08)] phone:h-36 phone:w-full"
    style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))` }}
    onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); at(event); }}
    onPointerMove={event => { if (event.buttons !== 0) at(event); }}
    onKeyDown={event => {
      const step = event.shiftKey ? 0.1 : 0.02;
      const move = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] } as Record<string, [number, number]>)[event.key];
      if (move === undefined) return;
      event.preventDefault();
      onChange({ h: hsv.h, s: clamp(hsv.s + move[0]), v: clamp(hsv.v + move[1]) });
    }}>
    <span aria-hidden="true" className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/.35)]"
      style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
  </div>;
}

/** The signal colour: any colour from the picker, with Pantone's colours of the year as presets. It previews on
 * the whole page as it moves and saves in the background once it settles. */
function AccentPicker({ view, csrf }: { view: BrowserSettingsView; csrf: string }) {
  const [hex, setHex] = useState(view.accent);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(view.accent));
  const [draft, setDraft] = useState(view.accent);
  const [saved, setSaved] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const choose = (next: string, from?: Hsv) => {
    setHex(next); setDraft(next); setHsv(from ?? hexToHsv(next)); previewAccent(next); setSaved(null);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const answer = await fetch("/settings/appearance", { method: "POST", body: new URLSearchParams({ csrf, accent: next, quiet: "1" }) }).catch(() => null);
      setSaved(answer?.ok ? "Saved" : "Not saved. Try again.");
    }, 400);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const commitDraft = () => { const next = normalHex(draft); if (next === null) setDraft(hex); else if (next !== hex) choose(next); };
  const preset = view.accentPresets.find(one => one.hex === hex);
  const note = accentNote(hex);
  return <div className="flex flex-col gap-3" data-accent-picker>
    <div className="flex flex-wrap gap-4">
      <ColourPlane hsv={hsv} onChange={next => choose(hsvToHex(next), next)} />
      <div className="flex min-w-0 flex-1 basis-52 flex-col gap-2.5">
        <input type="range" min={0} max={359} value={Math.round(hsv.h)} aria-label="Hue"
          onChange={event => { const next = { ...hsv, h: Number(event.target.value), s: hsv.s || 0.75, v: hsv.v || 0.75 }; choose(hsvToHex(next), next); }}
          className="h-3 w-full cursor-pointer appearance-none rounded-full phone:h-11 phone:bg-[length:100%_12px] phone:bg-center phone:bg-no-repeat bg-[linear-gradient(to_right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-transparent [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_rgb(0_0_0/.35)]" />
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="size-8 shrink-0 rounded-md shadow-[inset_0_0_0_1px_rgb(0_0_0/.12)]" style={{ background: hex }} />
          <Input value={draft} aria-label="Hex colour" spellCheck={false} autoComplete="off" className="w-28 font-mono"
            onChange={event => setDraft(event.target.value)} onBlur={commitDraft}
            onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commitDraft(); } }} />
          <Button variant="ghost" size="sm" disabled={hex === view.accentPresets[0]!.hex} onClick={() => choose(view.accentPresets[0]!.hex)}>Reset</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2" aria-hidden="true">
          <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-attention px-1.5 font-mono text-[11px] leading-none text-on-attention">3</span>
          <Badge tone="attention">Needs your decision</Badge>
          <span className="inline-flex h-7 items-center rounded-md bg-attention px-2.5 text-[12.5px] font-medium text-on-attention">Approve</span>
        </div>
        <p className="text-[12.5px] text-muted-foreground" aria-live="polite" data-accent-status>
          {preset !== undefined ? <>{preset.name}{preset.year !== null && <span className="font-mono"> {preset.year}</span>}</> : "Custom"}{saved !== null && ` · ${saved}`}
        </p>
      </div>
    </div>
    {note !== null && <p className="text-[12.5px] text-warning">{note}</p>}
    <div role="group" aria-label="Presets" className="flex flex-wrap gap-1.5">
      {view.accentPresets.map(one => <button key={one.id} type="button" data-preset={one.id} aria-pressed={one.hex === hex}
        aria-label={`${one.name}${one.year === null ? ", the default" : `, ${one.year}`}`} title={`${one.name}${one.year === null ? "" : ` · ${one.year}`}`}
        onClick={() => choose(one.hex)} style={{ background: one.hex }}
        className={cn("size-6 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/.12)] ring-offset-2 ring-offset-card transition-shadow phone:size-11",
          one.hex === hex ? "ring-2 ring-foreground" : "hover:ring-2 hover:ring-input")} />)}
    </div>
    <p className="text-[12.5px] text-muted-foreground">Presets are Pantone's colours of the year. Colours are deepened or lightened as needed so text stays readable. Saved in this browser.</p>
  </div>;
}

function DefaultChoice({ title, description, action, field, value, canManage, changed, options, csrf }: {
  title: string; description: string; action: string; field: string; value: string; canManage: boolean; changed: string | null; csrf: string;
  options: { value: string; title: string; description: string }[];
}) {
  const base = useId();
  const current = options.find(one => one.value === value);
  return <Section title={title} description={description}>
    {canManage ? <AutoForm action={action} csrf={csrf}>{submit => <>
      <RadioGroup name={field} defaultValue={value} onValueChange={submit} className="grid gap-2 desk:grid-cols-2" aria-label={title}>
        {options.map(one => <RadioCard key={one.value} id={`${base}-${one.value}`} value={one.value} title={one.title} description={one.description} />)}
      </RadioGroup>
      <noscript><Button type="submit" className="mt-3">Save</Button></noscript>
    </>}</AutoForm> : <p className="text-sm"><strong>{current?.title ?? value}</strong> <span className="text-muted-foreground">· an approver can change this</span></p>}
    {changed && <p className="text-[13px] text-muted-foreground">{changed}</p>}
  </Section>;
}

/** The email account: Send email steps send from it and Email inbox triggers read it — a mail server, or a
 * Google account instead. Passwords and the Google client secret are written here and never shown again. */
function Email({ email, csrf }: { email: NonNullable<BrowserSettingsView["email"]>; csrf: string }) {
  const google = email.google.connected;
  const status = google !== null ? `${google}, through Google` : email.set ? `From ${email.from} through ${email.host}${email.imapHost === "" ? "" : ` · reads ${email.imapHost}`}` : "Not set up";
  return <Section id="email" title="Email" description="Send email steps send from this account, and Email inbox triggers read it.">
    <Collapsible defaultOpen={!email.set && google === null}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-2 text-sm"><StatusDot tone={email.set || google !== null ? "ok" : "off"} />{status}</span>
        <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="ml-auto group">{email.set || google !== null ? "Change" : "Set up"}<ChevronRight className="transition-transform group-data-[state=open]:rotate-90" /></Button></CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        {google !== null
          ? <form method="post" action="/settings/google/disconnect" className="mt-3 grid gap-3 rounded-lg bg-muted p-4" data-google-connected>
              <Csrf csrf={csrf} />
              <p className="text-[13px]">Signed in with Google as <strong>{google}</strong>. Mail is sent and read through it.</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" variant="outline" formAction="/settings/email-test">Send a test email</Button>
                <Button type="submit" variant="outline" formAction="/settings/email-read-test">Check the inbox</Button>
                <Button type="submit" variant="ghost">Disconnect Google</Button>
              </div>
            </form>
          : <>
            <form method="post" action="/settings/email" className="mt-3 grid gap-3 rounded-lg bg-muted p-4" data-email-settings>
              <Csrf csrf={csrf} />
              <p className="text-[13px] text-muted-foreground">For Gmail: smtp.gmail.com, port 587, your address, and an app password. To read mail too, add imap.gmail.com.</p>
              <div className="grid gap-3 desk:grid-cols-[1fr_7rem]">
                <div className="grid gap-2"><Label htmlFor="email-host">Mail server</Label><Input id="email-host" name="host" defaultValue={email.host} placeholder="smtp.gmail.com" required /></div>
                <div className="grid gap-2"><Label htmlFor="email-port">Port</Label><Input id="email-port" name="port" type="number" min={1} max={65535} defaultValue={String(email.port)} required /></div>
              </div>
              <div className="grid gap-2"><Label htmlFor="email-from">Send from</Label><Input id="email-from" name="from" type="email" defaultValue={email.from} placeholder="you@example.com" required /></div>
              <div className="grid gap-2"><Label htmlFor="email-user">Username</Label><Input id="email-user" name="user" autoComplete="username" defaultValue={email.user} placeholder="Usually the same address" /></div>
              <div className="grid gap-2"><Label htmlFor="email-password">Password</Label><Input id="email-password" name="password" type="password" autoComplete="off" placeholder={email.set ? "Leave empty to keep the saved one" : "An app password"} /></div>
              <label className="flex items-center gap-2 text-[13px] phone:-ml-3.5 phone:min-h-11 phone:pl-3.5"><input type="checkbox" name="secure" className="size-4 accent-[var(--so-accent)]" defaultChecked={email.secure} />Use SSL from the start (port 465)</label>
              <div className="grid gap-3 desk:grid-cols-[1fr_7rem]">
                <div className="grid gap-2"><Label htmlFor="email-imap">Read mail from (optional)</Label><Input id="email-imap" name="imapHost" defaultValue={email.imapHost} placeholder="imap.gmail.com" /></div>
                <div className="grid gap-2"><Label htmlFor="email-imap-port">Port</Label><Input id="email-imap-port" name="imapPort" type="number" min={1} max={65535} defaultValue={String(email.imapPort)} /></div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit">Save email</Button>
                {email.set && <Button type="submit" variant="outline" formAction="/settings/email-test" formNoValidate>Send a test email</Button>}
                {email.set && email.imapHost !== "" && <Button type="submit" variant="outline" formAction="/settings/email-read-test" formNoValidate>Check the inbox</Button>}
              </div>
            </form>
            <details className="mt-3 rounded-lg border px-4 py-3" open={email.google.clientId !== "" && !email.set} data-google-setup>
              <summary className="cursor-pointer text-[13px] font-semibold phone:-my-3 phone:min-h-11 phone:py-3 phone:leading-5">Or sign in with a Google account</summary>
              <form method="post" action="/settings/google" className="mt-3 grid gap-3">
                <Csrf csrf={csrf} />
                <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted-foreground">
                  <li>In Google Cloud Console, make an OAuth client of type <em>Web application</em>, and set the consent screen to <em>In production</em> (while it's in Testing, Google ends the connection after 7 days).</li>
                  {email.google.redirect === null
                    ? <li>Open these settings on this computer (localhost) or at your https address to see the redirect address to add.</li>
                    : <li>Add this as an authorized redirect address: <code className="break-all rounded bg-muted px-1 py-0.5 text-foreground" data-google-redirect>{email.google.redirect}</code></li>}
                  <li>Paste the client ID and secret here, then connect. Google warns that it hasn't verified the app: it's your own, so continue.</li>
                </ol>
                <div className="grid gap-2"><Label htmlFor="google-id">Client ID</Label><Input id="google-id" name="clientId" defaultValue={email.google.clientId} placeholder="….apps.googleusercontent.com" required /></div>
                <div className="grid gap-2"><Label htmlFor="google-secret">Client secret</Label><Input id="google-secret" name="clientSecret" type="password" autoComplete="off" placeholder={email.google.clientId !== "" ? "Leave empty to keep the saved one" : ""} /></div>
                <Button type="submit" className="justify-self-start" disabled={email.google.redirect === null}>Connect Google</Button>
              </form>
            </details>
          </>}
      </CollapsibleContent>
    </Collapsible>
  </Section>;
}

function Providers({ providers, csrf }: { providers: NonNullable<BrowserSettingsView["providers"]>; csrf: string }) {
  return <Section id="providers" title="AI providers" description="Keys stay on this computer and are never shown again.">
    <ul className="-my-1 divide-y divide-border">
      {providers.map(one => <li key={one.provider} className="py-2">
        <Collapsible>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold">{one.name}</span>
            <span className="inline-flex items-center gap-2 text-sm text-muted-foreground"><StatusDot tone={one.tone} />{one.words}</span>
            <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="ml-auto group">Manage<ChevronRight className="transition-transform group-data-[state=open]:rotate-90" /></Button></CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <form method="post" action="/settings/provider-key" className="mt-3 grid gap-3 rounded-lg bg-muted p-4">
              <Csrf csrf={csrf} /><input type="hidden" name="provider" value={one.provider} />
              {one.connection && <p className="provider-connection text-sm"><strong>{one.connection.words}</strong> {one.connection.facts} · <a className="underline underline-offset-4" href={one.connection.checkHref}>Check again</a></p>}
              <p className="text-[13px] text-muted-foreground">{one.usage} · <code className="font-mono text-xs">{one.envName}</code></p>
              {one.subscriptionCapable && <div className="grid gap-2"><Label htmlFor={`${one.provider}-auth`}>Sign-in</Label>
                <Select name="auth-mode" defaultValue={one.mode}>
                  <SelectTrigger id={`${one.provider}-auth`}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="subscription">{one.name} subscription</SelectItem><SelectItem value="api-key">API key</SelectItem></SelectContent>
                </Select></div>}
              <div className="grid gap-2"><Label htmlFor={`${one.provider}-key`}>API key</Label>
                <Input id={`${one.provider}-key`} type="password" name="value" autoComplete="off" placeholder={one.set ? "Paste to replace the stored key" : "Paste a key"} /></div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit">Save {one.name}</Button>
                {one.set && <Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="text-destructive">Remove the stored key</Button></CollapsibleTrigger>
                  <CollapsibleContent className="mt-2 grid gap-2"><p className="text-[13px] text-muted-foreground">Runs that use this API key stop until you add one again.</p>
                    <Button type="submit" variant="destructive" size="sm" formAction="/settings/provider-key-clear">Remove key</Button></CollapsibleContent></Collapsible>}
              </div>
            </form>
          </CollapsibleContent>
        </Collapsible>
      </li>)}
    </ul>
  </Section>;
}

function Workers({ workers }: { workers: NonNullable<BrowserSettingsView["workers"]> }) {
  return <Section id="workers" title="Workers" description="How many tasks each worker runs at once, and what it is running now.">
    {workers.length === 0
      ? <p className="text-sm text-muted-foreground">No worker is connected. Run <code className="font-mono text-xs">toolroll up</code> on the computer with your projects.</p>
      : <ul className="-my-1 divide-y divide-border">
        {workers.map(one => <li key={one.name} className="grid gap-1.5 py-2.5" data-worker={one.name}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 break-all font-semibold">{one.name}</span>
            <span className="inline-flex items-center gap-2 text-sm text-muted-foreground"><StatusDot tone={one.tone} />{one.state}</span>
            <span className="ml-auto text-sm tabular-nums" data-worker-load>{one.busy} of {one.capacity} running</span>
          </div>
          {one.running.length === 0
            ? <p className="text-[13px] text-muted-foreground">Nothing running.</p>
            : <ul className="grid gap-1">{one.running.map(task => <li key={task.taskId} className="flex min-w-0 items-baseline gap-2 text-sm">
              <a className="min-w-0 truncate underline-offset-4 hover:underline phone:min-h-11 phone:leading-[44px]" href={task.href}>{task.title}</a>
              {task.project && <span className="shrink-0 text-[13px] text-muted-foreground">{task.project}</span>}
            </li>)}</ul>}
        </li>)}
      </ul>}
    {workers.length > 0 && <p className="mt-3 text-[13px] text-muted-foreground">To change how many a worker runs at once: <code className="font-mono text-xs">toolroll runner capacity &lt;name&gt; &lt;n&gt;</code></p>}
  </Section>;
}

/** Settings → Updates: this version, the latest and its notes, the command that updates this install, the daily check, and each worker's version. */
function Updates({ updates, csrf, firstResult }: { updates: NonNullable<BrowserSettingsView["updates"]>; csrf: string; firstResult: string | null }) {
  const latest = updates.latest;
  const newer = latest !== null && latest.newer ? latest : null;
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(updates.updateCommand).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }, () => {}); };
  return <Section id="updates" title="Updates">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-updates-state={newer ? "newer" : !updates.check.on ? "off" : latest === null ? "unchecked" : "current"}>
      <span className="text-sm">This version <span className="font-mono text-[12.5px]">{updates.current}</span></span>
      <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        {newer ? <><StatusDot tone="neutral" /><span><span className="font-mono text-[12.5px] text-foreground">{newer.version}</span> is available</span></>
          : !updates.check.on ? <><StatusDot tone="off" />Checks are off</>
          : latest === null ? <><StatusDot tone="off" />Not checked yet</>
          : <><StatusDot tone="ok" />Up to date</>}
      </span>
      {newer?.security && <Badge tone="warning">Security fixes</Badge>}
    </div>
    {firstResult !== null && <p className="text-[13px] text-muted-foreground" data-first-result>{firstResult}</p>}
    {newer && <div className="grid gap-2 rounded-lg bg-muted p-3 phone:p-3" data-update-command>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-words font-mono text-[12.5px]">{updates.updateCommand}</code>
        <Button variant="outline" size="sm" onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
      </div>
      <p className="text-[12.5px] text-muted-foreground">Run it on this computer, then restart Toolroll.</p>
    </div>}
    {newer && <Collapsible>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="group -ml-2.5" disabled={newer.notes === ""}>What's new in {newer.version}<ChevronRight className="transition-transform group-data-[state=open]:rotate-90" /></Button></CollapsibleTrigger>
        <a className="text-[13px] underline underline-offset-4" href={newer.url} target="_blank" rel="noreferrer">Release page</a>
      </div>
      <CollapsibleContent>
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border p-3 font-sans text-[13px] leading-relaxed" data-update-notes>{newer.notes}</pre>
      </CollapsibleContent>
    </Collapsible>}
    <Separator />
    <AutoForm action="/settings/updates/checks" csrf={csrf} className="flex items-center justify-between gap-4">{submit => <>
      <div className="grid gap-0.5">
        <Label htmlFor="update-check">Check for a newer version once a day</Label>
        <span className="text-[12.5px] text-muted-foreground">{updates.check.byEnv ? "Off by TOOLROLL_NO_UPDATE_CHECK." : "One anonymous request to npm and GitHub. Nothing about you is sent."}</span>
      </div>
      <Switch id="update-check" name="check" value="on" defaultChecked={updates.check.on} disabled={!updates.check.canManage || updates.check.byEnv} onCheckedChange={submit} />
    </>}</AutoForm>
    {updates.workers.length > 0 && <>
      <Separator />
      <ul className="-my-1 divide-y divide-border" aria-label="Worker versions">
        {updates.workers.map(one => <li key={one.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" data-worker-version={one.name}>
          <span className="min-w-0 break-all text-sm font-medium">{one.name}</span>
          <span className={cn("ml-auto text-muted-foreground", one.version === null ? "text-[12.5px]" : "font-mono text-[12.5px]")}>{one.version ?? "Version not reported"}</span>
          {one.older && <Badge tone="warning">Older</Badge>}
        </li>)}
      </ul>
    </>}
  </Section>;
}

/** Screenshots with results (result-shots.ts keeps the same three). */
const SCREENSHOT_CHOICES = [["off", "Off"], ["first", "First one"], ["all", "Up to 4"]] as const;

function Notifications({ view, csrf }: { view: BrowserSettingsView; csrf: string }) {
  const base = useId();
  if (!view.chat && view.services === null && view.push === null && view.digest === null) return null;
  return <Section id="notifications" title="Notifications">
    {view.chat && <AutoForm action="/settings/notifications" csrf={csrf} className="grid gap-4 phone:gap-3">{submit => <>
      <RadioGroup name="mode" defaultValue={view.chat!.mode} onValueChange={submit} className="grid gap-2 desk:grid-cols-2" aria-label="Chat messages">
        <RadioCard id={`${base}-quiet`} value="quiet" title="Only when I'm needed" description="One message per task, updated as it moves." />
        <RadioCard id={`${base}-all`} value="all" title="Every step" description="A new message for each update." />
      </RadioGroup>
      <div className="grid gap-2">
        <Label htmlFor={`${base}-evening`}>Evening digest</Label>
        <Select name="digest" defaultValue={view.chat!.digestAt ?? "off"} onValueChange={submit}>
          <SelectTrigger id={`${base}-evening`} className="desk:max-w-72"><SelectValue /></SelectTrigger>
          <SelectContent>{digestTimes(view.chat!.digestAt).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
        </Select>
        <p className="text-[13px] text-muted-foreground">One message: what finished, what waits, what failed.</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${base}-screenshots`}>Screenshots with results</Label>
        <Select name="screenshots" defaultValue={view.chat!.screenshots ?? "off"} onValueChange={submit}>
          <SelectTrigger id={`${base}-screenshots`} className="desk:max-w-72"><SelectValue /></SelectTrigger>
          <SelectContent>{SCREENSHOT_CHOICES.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <noscript><Button type="submit">Save</Button></noscript>
    </>}</AutoForm>}
    {view.chat?.projects && view.chat.projects.length > 0 && <div className="grid gap-2">
      <span className="font-semibold">Projects</span>
      <ul className="-my-1 divide-y divide-border" aria-label="Project pings">
        {view.chat.projects.map((one, index) => <li key={one.repo} data-project-pings={one.name}>
          <AutoForm action="/settings/notifications/mute" csrf={csrf} className="flex items-center justify-between gap-4 py-2">{submit => <>
            <input type="hidden" name="repo" value={one.repo} />
            <Label htmlFor={`${base}-mute-${index}`} className="min-w-0 break-all">{one.name}</Label>
            <Switch id={`${base}-mute-${index}`} name="pings" value="on" defaultChecked={!one.muted} onCheckedChange={submit} aria-label={`Pings for ${one.name}`} />
            <noscript><Button type="submit" size="sm" variant="outline">Save</Button></noscript>
          </>}</AutoForm>
        </li>)}
      </ul>
      <p className="text-[13px] text-muted-foreground">Off: no pings. It still shows in Tasks and the evening digest.</p>
    </div>}
    {view.chat && view.services && <Separator />}
    {view.services && (view.services.configured.length === 1 && !view.services.implicit
      ? <div className="flex items-center gap-3"><span className="font-semibold capitalize">{view.services.configured[0]}</span><span className="inline-flex items-center gap-2 text-sm text-muted-foreground"><StatusDot tone="ok" />Receiving alerts</span></div>
      : <AutoForm action="/settings/messaging" csrf={csrf}>{submit => <div className="grid gap-2">
        <Label>Alert service</Label>
        {view.services!.implicit && <p className="text-[13px] text-warning">Several are connected and none was chosen. Pick one.</p>}
        <RadioGroup name="primary" {...(view.services!.channel === null ? {} : { defaultValue: view.services!.channel })} onValueChange={submit} className="grid gap-2 desk:grid-cols-2">
          {view.services!.configured.map(one => <RadioCard key={one} id={`${base}-${one}`} value={one} title={one.charAt(0).toUpperCase() + one.slice(1)} description={one === "telegram" ? "Answer buttons and replies" : "Messages with links"} />)}
        </RadioGroup></div>}</AutoForm>)}
    {view.push && <>
      <Separator />
      <div className="grid gap-3">
        <div className="grid gap-1"><span className="font-semibold">This device</span>
          <span className="text-[13px] text-muted-foreground">{view.push.available ? "A notification when something needs you. On iPhone, add this app to your Home Screen first." : "Alerts need a secure (https) address for this app."}</span></div>
        {view.push.available && <form method="post" action="/push/subscribe" id="push-form" className="flex flex-wrap items-end gap-3">
          <Csrf csrf={csrf} /><input type="hidden" name="endpoint" value="" /><input type="hidden" name="p256dh" value="" /><input type="hidden" name="auth" value="" />
          <div className="grid min-w-56 flex-1 gap-2"><Label htmlFor="push-password">Your password</Label><Input id="push-password" type="password" name="token" autoComplete="current-password" /></div>
          <Button type="submit" id="push-enable" variant="outline">Get alerts on this device</Button>
          <p className="w-full text-[13px] text-muted-foreground" id="push-state" aria-live="polite"></p>
        </form>}
        {view.push.devices.length > 0 && <ul className="grid gap-2">{view.push.devices.map(one => <li key={one.id} className="flex flex-wrap items-center gap-3 text-sm">
          <span>{one.words}</span>{one.state !== "ok" && <Badge tone={one.state === "failing" ? "warning" : "neutral"}>{one.state}</Badge>}
          {one.removable && <form method="post" action="/push/remove" className="ml-auto"><Csrf csrf={csrf} /><input type="hidden" name="id" value={one.id} /><Button type="submit" variant="ghost" size="sm">Remove</Button></form>}
        </li>)}</ul>}
      </div>
    </>}
    {view.digest && <>
      <Separator />
      <AutoForm action="/settings/telegram-digest" csrf={csrf} className="grid gap-2">{submit => <>
        <Label htmlFor={`${base}-digest`}>Telegram digest</Label>
        <p className="text-[13px] text-muted-foreground">Bundle routine updates. Anything that needs you still arrives at once.</p>
        <Select name="every" defaultValue={view.digest!.every} onValueChange={submit}>
          <SelectTrigger id={`${base}-digest`} className="desk:max-w-72"><SelectValue /></SelectTrigger>
          <SelectContent>{[["off", "Off: send each update"], ["30", "Every 30 minutes"], ["60", "Every hour"], ["240", "Every 4 hours"], ["720", "Every 12 hours"], ["1440", "Once a day"]].map(([value, label]) => <SelectItem key={value} value={value!}>{label}</SelectItem>)}</SelectContent>
        </Select>
        {view.digest!.held && <p className="text-[13px] text-muted-foreground">{view.digest!.held}</p>}
      </>}</AutoForm>
    </>}
  </Section>;
}

function TelegramToken({ view, csrf }: { view: BrowserSettingsView; csrf: string }) {
  return <Collapsible className="rounded-lg border border-border bg-card">
    <CollapsibleTrigger asChild><button className="group flex w-full items-center justify-between gap-3 px-5 py-4 text-left phone:px-4">
      <span className="font-semibold">Telegram bot token <span className="ml-2 text-sm font-normal text-muted-foreground">{view.telegram.state}</span></span>
      <ChevronRight className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
    </button></CollapsibleTrigger>
    <CollapsibleContent className="grid gap-3 border-t border-border px-5 py-4 phone:px-4">
      <p className="text-[13px] text-muted-foreground">Current: {view.telegram.current}</p>
      {view.telegram.delivery != null && <p className="text-[13px] text-muted-foreground" data-telegram-delivery>{view.telegram.delivery}</p>}
      <form method="post" action="/settings/telegram-token" className="flex flex-wrap items-end gap-3">
        <Csrf csrf={csrf} />
        <div className="grid min-w-56 flex-1 gap-2"><Label htmlFor="telegram-token-field">Token from @BotFather</Label><Input id="telegram-token-field" type="password" name="token" autoComplete="off" /></div>
        <Button type="submit" variant="outline">Save token</Button>
      </form>
      <p className="text-[13px] text-muted-foreground">Stored privately on this computer. Then pair your phone under <a className="underline underline-offset-4" href="/settings/telegram">Telegram</a>.</p>
    </CollapsibleContent>
  </Collapsible>;
}

export function SettingsView({ view, csrf }: { view: BrowserSettingsView; csrf: string }) {
  const [said] = useState(view.said);
  useEffect(() => { if (said) toast(said.charAt(0).toUpperCase() + said.slice(1)); }, [said]);
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 phone:gap-3">
    <h1 className="sr-only">Settings</h1>
    <nav aria-label="Settings sections" className="grid gap-4 phone:gap-3">
      {view.groups.map(group => <section key={group.title} aria-labelledby={`settings-${slug(group.title)}`} className="grid gap-2 phone:gap-1.5">
        <h2 id={`settings-${slug(group.title)}`} className="text-sm font-semibold text-muted-foreground">{group.title}</h2>
        <div className="grid grid-cols-2 gap-2 desk:grid-cols-4 phone:gap-1.5">
          {group.tiles.map(tile => <a key={tile.href} href={tile.href} className="flex min-h-12 items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold phone:min-h-11 phone:gap-2 phone:px-2.5 transition-colors hover:bg-accent [&>svg]:size-[18px] [&>svg]:shrink-0 [&>svg]:text-primary">
            {tile.brand === undefined ? TILE_ICONS[tile.href] : <BrandIcon id={tile.brand} />}
            <span className="grid min-w-0 gap-0.5">{tile.label}
              {tile.status && <span className="flex items-center gap-1.5 text-[13px] font-normal text-muted-foreground"><StatusDot tone={tile.status.tone} />{tile.status.words}</span>}</span></a>)}
        </div>
        {group.title === "Chat apps" && view.phone && <PhoneCard phone={view.phone} csrf={csrf} dismissable={false} />}
      </section>)}
    </nav>
    <Section title="Appearance"><Themes view={view} csrf={csrf} /></Section>
    <Section id="accent" title="Accent colour" description="The one colour that marks what needs you."><AccentPicker view={view} csrf={csrf} /></Section>
    {view.permission && <DefaultChoice title="Unattended permissions" description="The starting choice for new tasks. Approved tasks keep their setting." action="/settings/permission-default" field="permission-mode"
      value={view.permission.mode} canManage={view.permission.canManage} changed={view.permission.changed} csrf={csrf}
      options={[{ value: "auto", title: "Auto", description: "Asks before risky actions." }, { value: "bypassPermissions", title: "Full access", description: "Never asks and can change files anywhere on this computer. Trusted repositories only." }]} />}
    {view.quality && <DefaultChoice title="Quality mode" description="Publishing and deploying still need their own approval." action="/settings/quality-default" field="quality-mode"
      value={view.quality.mode} canManage={view.quality.canManage} changed={view.quality.changed} csrf={csrf}
      options={[{ value: "default", title: "Default", description: "Everyday agents and the repository check." }, { value: "strict", title: "Strict / release", description: "Strongest agents. Release approval stays separate." }]} />}
    {view.providers && <Providers providers={view.providers} csrf={csrf} />}
    {view.workers && <Workers workers={view.workers} />}
    {view.updates ? <Updates updates={view.updates} csrf={csrf} firstResult={view.firstResult ?? null} />
      : view.firstResult && <Section title="This installation"><p className="text-sm" data-first-result>{view.firstResult}</p></Section>}
    {view.email && csrf && <Email email={view.email} csrf={csrf} />}
    <Notifications view={view} csrf={csrf} />
    {csrf && <TelegramToken view={view} csrf={csrf} />}
  </div>;
}
