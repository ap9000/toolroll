# Webhook fixtures

Deliveries as their senders send them, for the provider readers (src/webhook-readers.ts). Each file is one body,
byte for byte; its `.json` name says the sender and the event.

- `*.documented.json`: written from the sender's documentation (shape only). The readers built on them say so on the
  panel until a real delivery has passed through: replace each with a captured one when it arrives.
- `*.captured.json`: a real delivery, captured, with every secret, token and personal value replaced. Signatures in
  tests are recomputed over these bytes with a test key; no real secret is ever stored here.
