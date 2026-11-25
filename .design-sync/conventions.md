# The Operations Ledger — build conventions

This is the console design system for **standing-orders**, a control plane for unattended coding agents. It is a **custom shadcn/ui theme**: dark-first ink, one committed theme (no light mode). Every screen you build must sit on the ink ground — give the page root `bg-background text-foreground font-sans` (the shipped stylesheet also styles `body` with these).

## The one rule that defines this system

**Amber (`--primary`) means "waits on you" — nothing else.** Use `bg-primary` / `text-primary` only for: the `waits-on-you` StatusChip, the amber top rule on AttentionCard/CeremonySurface, NavBar badges, and the single Button that resolves a wait (`<Button>` default variant — most screens have at most one). Never use amber for links, highlights, or decoration. Everything else is ink on ink.

## Styling idiom: Tailwind utilities over the theme tokens

Colors (all defined in `styles.css`): `bg-background` (page ground), `bg-card` (surfaces), `bg-popover` (inset wells: inputs, seals, code), `border-border` (hairlines — bare `border-b` etc. also resolves to it), `text-foreground`, `text-muted-foreground` (secondary text), `bg-primary` + `text-primary-foreground` (amber, see rule above), `text-destructive`.

Run-state colors — chips only, never surfaces: `text-running`/`text-built`/`text-failed` with `bg-running/12` + `border-running/40` (same pattern for built/failed). Prefer the StatusChip component over hand-rolling these.

Radii: `rounded-lg` for cards, `rounded-md` for controls, `rounded-full` for chips. Fonts: `font-sans` (IBM Plex Sans) is the human voice; **`font-mono` (IBM Plex Mono) is mandatory for every machine fact** — model ids, digests, paths, costs, durations, timestamps, branch names. If the machine asserts it, set it in mono.

## Vocabulary components (use these before composing raw primitives)

- `StatusChip` — the console's entire status vocabulary: `waits-on-you | running | built | failed | queued`. Never invent other status words or colors.
- `AttentionCard` — anything waiting on the user. `CeremonySurface` — **every** password form, no exceptions: terms restated, `DigestSeal`, password, one amber action.
- `Ledger` + `LedgerRow` — finished/in-flight work as a record ("Built today", attempt histories, queues). Not stacks of prose cards.
- `KeyValueRow` — fact lists (scope cards, task details); set `mono` on machine-fact values.
- `PageHeader`, `NavBar`, `TextField`, `DigestSeal` — screen chrome and forms.
- shadcn primitives for everything else: `Button`, `Card` (+`CardHeader`/`CardTitle`/`CardDescription`/`CardAction`/`CardContent`/`CardFooter`), `Badge`, `Input`, `Label`, `Separator`.

## Where the truth lives

Read `styles.css` (imports the compiled theme — every token above is defined there) and each component's `.d.ts` + `.prompt.md`. Copy in the previews is the voice to imitate: plain words ("2 waiting · 1 running"), lowercase mono nav labels, sentences not jargon.

## Idiomatic example

```tsx
<div className="bg-background text-foreground font-sans min-h-screen p-4 flex flex-col gap-4">
  <PageHeader title="Standing Orders" subtitle="2 waiting · 1 running · 3 built today" />
  <AttentionCard title="Approve scope for my-tool" meta="task #12"
    action={<Button size="sm">Review and sign</Button>}>
    <div>
      <KeyValueRow label="runs on" value="claude · sonnet" mono />
      <KeyValueRow label="budget" value="$5.00 per run" mono />
    </div>
  </AttentionCard>
  <Ledger heading="Built today">
    <LedgerRow title="Fix flaky auth test" meta="claude · sonnet · 14m · $0.82" status="built" />
  </Ledger>
</div>
```
