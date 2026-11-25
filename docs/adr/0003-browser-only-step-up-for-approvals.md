# Browser-Only Step-Up for High-Trust Approvals

High-trust actions — approving a Task plan, merging or shipping a pull request, minting or rotating credentials, and changing Workspace policy — require a browser Sign-In Session with fresh credential or identity-provider step-up proof. Remote non-browser clients holding an Access Token (including the remote TUI and CLI) can steer, revise, trigger Task Handoff, attach to Live Terminals, and send approval pings, but can never self-approve; they always route the human to the browser or phone and trust only authoritative server state afterward.

## Considered Options

- **Allow remote TUI keyboard step-up (re-typing password over CLI/TUI)**: Removes the context switch to a browser when approving from a terminal, but turns every headless client and compromised laptop terminal into a direct approval surface and duplicates phishing/session-binding defenses outside the browser origin model.
- **Treat `act` Access Tokens as full Approver authority**: Maximizes automation and speed, but collapses the boundary between routine collaboration and irreversible ship/credential actions if a long-lived token leaks.

## Consequences

- Every remote TUI approval flow hands off cleanly to a browser URL or out-of-band phone ping and watches live server events for confirmation rather than accepting local approval input.
- A leaked Access Token cannot silently approve plans, ship code, or mint new credentials.
