# Retire All Credentials Unconditionally on Backup Restore

Restoring a Workspace from a backup keeps its permanent Workspace identity intact, advances its Recovery Generation, and unconditionally retires every restored credential — including browser sessions, remote TUI/CLI API tokens, OAuth grants, lead/coordinator credentials, publication/intake grants, and chat pairings with their pairing codes, rooms and buttons — with zero exemptions.

## Considered Options

- **Keep human or bot API tokens alive across restore**: Avoids disconnecting live TUIs and CI automations after recovery, but lets credentials revoked *after* the backup was taken silently come back to life and lets clients on a split-brain or pre-crash state keep mutating against rolled-back history.
- **Selective exemption for CI/bot tokens**: Preserves automation continuity, but reintroduces zombie-token replay for the highest-volume automated callers and creates an asymmetric trust exception.

## Consequences

- Every connected remote TUI, browser tab, and automation fails closed immediately after a restore and must re-pair or re-issue credentials against the new Recovery Generation.
- Never-enrolled solo local installs keep their existing local restore flow without adding multi-user friction.
