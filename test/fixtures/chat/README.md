# Saved chat payloads, before `version`

Read-only samples for the chat contracts (`src/contracts/chat-*.ts`, `telegram-callback.ts`, `slack-callback.ts`,
`discord-callback.ts`, `teams-callback.ts`). Each is written in the exact shape the 0.9.36 writers saved or the chat
apps sent — `prepareSharedAction`, `ChatState.plan` and `enqueue`, the Slack, Discord and Teams receivers, the Telegram
push inbox and the button tables — with synthetic ids, names, hashes and tokens. Nothing here came from a real
database or a real person; the repository is public.

The contract tests replay every sample and check it reads as it did before: the same fields and values, the same
request bytes (so a saved proposal's stamp still matches), and the same delivery state.
