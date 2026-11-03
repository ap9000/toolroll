# Toolroll's design system

Toolroll's UI follows one youiyoux System, `toolroll` (`youi.config.json` at the repo root; this product follows it
through `youi.project.json`). The rules for building pages with it are in [KIT.md](KIT.md).

| File | What it is |
| --- | --- |
| `system/tokens/*.json` | The tokens (DTCG): Signal 1.0.0's, forked from ap9000/toolroll-design at `9e35768563af63d876e6377e6b0b74fc0399e297`, plus the revamp kit's (KIT.md "Tokens"). Edit tokens here. |
| `system/components/*/…contract.json` | A contract per kit component in `src/browser/kit`: props, tokens, accessibility, guidance. |
| `system/rules/*.rule.yaml` | The rules `youiyoux check` enforces (raw colours, arbitrary values, lookalike and native controls, contract values) and two it only states. |
| `tokens.css` | Generated. Every `--so-*` variable, light and dark (device scheme and a pinned `data-theme`). The server prepends it to `src/server/console.css` (`STYLE` in `src/server/chrome.ts`), so every page, including the React workspace, gets one copy. |
| `theme.css` | Generated. The Tailwind theme: colour, radius, shadow, type and phone-spacing utilities, each reading a `--so-*` variable. `src/browser/tailwind.css` imports it. |
| `SYSTEM.md` | Generated. The System as agents read it. |
| `kit.css`, `kit.ts`, `KIT.md` | The revamp kit: its look (`k-*` classes, appended to the served sheet), its words and approval rules, and its rules. |

To change a token, contract or rule: edit it under `system/`, then run `npx youiyoux@0.1.21 sync` from the repo root
and commit what it wrote (`tokens.css`, `theme.css`, `SYSTEM.md`, `youi.lock.json`, the youiyoux skill, `youi-rules/`
and the AGENTS.md block). Never edit the generated files by hand. `youi.baseline.json` records the violations that
predate the kit; the pull-request check fails only on what a change adds.
