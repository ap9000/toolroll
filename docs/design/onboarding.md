# Onboarding: from `npx toolroll up` to a first result, without a form

*Design brief, 2026-10-01, for the launch on 2026-10-06. Walked as a stranger in a clean Linux container and on macOS.*

## What a stranger meets today

1. **A login wall.** `toolroll up` opens the browser on a login page. The password is printed in the terminal (or saved in a file when there's no terminal), so the first thing a newcomer does is copy a random password.
2. **"Wrong host".** Opening the console at any address other than the one it was started for (a Docker port, a LAN name, a tailnet name) shows a bare "wrong host" page with no explanation.
3. **The lead is switched off.** Chat (the lead, the heart of the product) is "not configured yet", with a setup form: provider, "model (use default for your membership's current model; direct API models need a pinned price)", "weekly ceiling (direct API only…)", "daily turns", "API key (anthropic_api: none yet…)". Even when Claude Code is installed and signed in.
4. **Then it's good.** The first-run checklist (Agent signed in, Project added, Your first task) and the suggested first tasks work, but they sit below a disabled chat.
5. **Nothing explains the loop.** The words Ready, Complete, approve and scope arrive before anyone has said what happens to a request.

## The first ten minutes we want

1. `npx toolroll up` in a repository. The terminal prints three lines: the console address, "Opening it now", and what to do if it doesn't open.
2. **The browser opens signed in**: a one-time sign-in link (single use, expires in 10 minutes, accepted only from this machine, never logged), landing on Chat. The password stays saved as today for later and for other devices.
3. **The lead is already on**, using the agent CLI that's signed in (Claude Code first, else Codex, else Gemini) and its membership, with today's safe defaults. One line says so ("The lead uses your Claude Code sign-in · Change"); the full form moves under Settings → Lead as "Advanced". If no agent is signed in, Chat shows the one command to install and sign in for this OS, and checks again on its own.
4. **One sentence of how it works**, shown once above the composer: "Ask for a change. You approve a short plan; an agent builds it on its own branch; it comes back Ready with the result and its check status." With three suggestions from this repository (the existing first tasks).
5. **The first task is guided.** After the first request: a small timeline on the task (Plan → You approve → Build → Checks → Ready) that fills in as it moves, so the first wait is never a mystery.
6. **After the first Ready result**, one card offers the phone: pair Telegram (or Slack, Discord, Teams) in two steps, or open the console on the phone over Tailscale (with the address to type).
7. **Wrong host explains itself**: the page names the address it was opened at and the address it serves, and gives the exact restart command (`toolroll up --allow-host <name:port>`); localhost and 127.0.0.1 on the served port, and the machine's own tailnet name when Tailscale is up, are allowed without asking.
8. **The demo hands off**: `toolroll demo`'s banner and its last step say how to start on a real project (`npx toolroll up` in your repository).

## Done when

A fresh install on a machine with Claude Code signed in reaches a filed first task without typing a password or filling a form, and the same on a machine with no agent shows exactly what to install. Screenshots at 1440 and 390 of each step; a scripted journey in scripts/app-e2e.mjs that starts from an empty home folder.
