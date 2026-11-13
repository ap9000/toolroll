# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: the person who runs the installation and a small team of teammates. They hand outcomes to coding agents, approve exact scopes, and inspect finished work from a desk (laptop browser, terminal) and from a phone (mobile browser, Telegram, Slack, Discord, Teams). Most of the time nobody is watching: the operator may be asleep, in meetings or away, and comes back to decisions and results.

Secondary (confirmed 2026-09-22): open-source adopters who install their own copy. The product must make sense to a first-time user who did not build it.

## Product Purpose

Toolroll is a control plane for unattended coding agents. A person tells a lead agent what outcome they want; the lead plans it; the person approves the exact contract once; crew agents build it under the approved terms; the result comes back as **Ready** with the saved diff, checks and screenshots; a person marks it **Complete** or asks for a specific revision. Success means the person spends minutes supervising, not hours watching, and is interrupted only for decisions that genuinely need a human.

## Positioning

One central installation, many surfaces, one truth: browser, CLI and every chat app act on the same durable tasks, approvals and history in one local database. It is not a chat-only copy of the work, and there is no automatic model-review or resubmission loop. Approvals bind exact routing (model, permissions, evidence), and deployment still requires the exact passing machine check. MIT licensed, zero runtime dependencies.

## Operating Context

- Flow: Request → plan → approval → execution → Ready → human inspection → Complete or explicit revision.
- Main areas: **Chat** (the lead conversation across projects), **Tasks** (queue, running work, results), **Projects** (guidance, knowledge, memory), **Settings** (models, permissions, channels, people).
- Real usage scenes: glancing at a phone between meetings to approve a plan or read a result; a desk session inspecting a diff and checks; a teammate joining a shared team conversation.
- Everything also exists as CLI verbs and chat actions; the browser is one of several equal surfaces.

## Capabilities and Constraints

- Server-rendered HTML with a React workspace shell for the browser; no CDN assets; strict CSP with nonces; pages must work without JavaScript beyond the shell.
- Sensitive pages (password entry, one-time secrets) strip chrome scripts by design.
- Terminology that must stay stable: Ready, Complete, revision, scope, approval, lead, crew, task, result, project knowledge, decisions.
- Truthful status is non-negotiable: never hide a failing check, a limitation or an unknown spend.

## Brand Commitments

- Name: Toolroll. It was called Standing Orders before 0.5.0; that name survives only in compatibility identifiers (config folder, environment variables, the `standing-orders` command alias).
- Voice: plain English, concise, calm; say it once; describe what happened and what the person can do (see AGENTS.md "simple, elegant UI").
- Geist and Geist Mono are the product's typefaces (self-hosted in `/fonts`; chosen 2026-09-27, replacing IBM Plex).
- Visual register (chosen 2026-09-27): the Raycast and Arc canon played straight. Neutral grey with one signature accent, the ink accent, reserved for what waits on a person; ink for every other act. Craft bar: Raycast, Arc, Linear, Vercel.

## Evidence on Hand

- Real screenshots in `docs/media/ui/` and the live installation's tasks, results and conversations.
- No customer logos, testimonials, benchmarks or pricing exist; do not invent them.

## Product Principles

1. Wake me only for these: surface what needs a person first; everything else is calm and available on demand.
2. One truth, many surfaces: a change anywhere is the same change everywhere.
3. Exactness over reassurance: show the real check, the real model, the real cost.
4. Desk and phone are equal: every decision can be made comfortably on a phone.
5. Understandable to a stranger: an open-source adopter can find the next action without a paragraph.

## Accessibility & Inclusion

WCAG AA contrast in both light and dark themes, keyboard access for every action, 44px touch targets on phones, reduced motion respected (existing requirement in AGENTS.md).
