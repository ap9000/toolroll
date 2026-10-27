/**
 * The closed list of credential acts (docs/plans/passwordless.md): each one proves with a password typed now — the
 * credential check — never the ordinary step-up a session or the CLI's remembered login can satisfy. A static guard:
 * an edit that moves one of these onto the ordinary check fails here and has to be reviewed.
 */
import { expect, test } from "vitest";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(new URL(`./${path}`, import.meta.url), "utf8");

/** Every credential act: the file and the exact credential-checking line it must keep. */
const CREDENTIAL_ACTS: ReadonlyArray<{ act: string; file: string; line: RegExp }> = [
  { act: "creating an approver (CLI and console)", file: "scope.ts", line: /const vouching = by === undefined \? \{ ok: false as const \} : proveCredential\(store, by\.name, by\.token\);/ },
  { act: "minting an API token", file: "server/people-tokens.ts", line: /who\.role === "approver" \? authenticateCredential\(who, typed\)\.ok/ },
  { act: "widening access", file: "server/people-tokens.ts", line: /if \(!authenticateCredential\(who, body\.get\("token"\) \?\? "", null\)\.ok\) return refuse\(response, who, 403, "Saving access requires your password\."/ },
  { act: "inviting someone", file: "server/people-tokens.ts", line: /if \(!authenticateCredential\(who, token\)\.ok\) \{\n\s*return refuse\(response, who, 403, "making an invite takes your password/ },
  { act: "connecting an outside app (OAuth)", file: "server/remote.ts", line: /const proved = proveAccountNow\(store, who\.name, typed, \{ credential: true \}\); return proved\.ok && credentialProof\(proved\.method\);/ },
  { act: "registering a worker (console)", file: "server/pages.ts", line: /if \(!authenticateCredential\(who, token\)\.ok\) \{\n\s*return refuse\(response, who, 403, "registering a worker/ },
  { act: "a webhook's setup, secret, sender or scope", file: "server/flows.ts", line: /if \(!authenticateCredential\(who, body\.get\("password"\) \?\? ""\)\.ok\) return answer\(403, \{ ok: false, said: verb === "secret"/ },
  { act: "adding a trigger that takes deliveries (console)", file: "server/flows.ts", line: /if \(ingress && !authenticateCredential\(who, body\.get\("password"\) \?\? ""\)\.ok\) return answer\(403/ },
  { act: "a public form link, or a new webhook address", file: "server/flows.ts", line: /if \(\(verb === "share" \|\| verb === "renew"\) && !authenticateCredential\(who, body\.get\("password"\) \?\? ""\)\.ok\) \{/ },
  { act: "CLI: adding a trigger that takes deliveries", file: "flows-cli.ts", line: /if \(ingress && !proveCredential\(store, acting\.name, acting\.token\)\.ok\) return refuse/ },
  { act: "an address is minted only with proof", file: "flow-triggers.ts", line: /const token = takesDeliveries\(config\) && options\.ingress === "proved" &&/ },
  { act: "sign-in methods and the identity provider", file: "server/settings.ts", line: /if \(!authenticateCredential\(who, body\.get\("password"\) \?\? ""\)\.ok\) return back\("problem", "Enter your Toolroll password to change sign-in\."\);/ },
  { act: "connecting or pairing Slack", file: "server/settings.ts", line: /if\(!\(action==="connect"\|\|action==="pair" \? authenticateCredential\(who, body\.get\("password"\)\?\?""\) : authenticateApprover\(who, body\.get\("password"\)\?\?""\)\)\.ok\) return show\("Enter your Toolroll password to change Slack access/ },
  { act: "connecting or pairing Teams", file: "server/settings.ts", line: /if \(!\(action === "connect" \|\| action === "pair" \? authenticateCredential\(who, body\.get\("password"\) \?\? ""\) : authenticateApprover\(who, body\.get\("password"\) \?\? ""\)\)\.ok\) return show\("Enter your Toolroll password to change Teams access/ },
  { act: "connecting or pairing Discord", file: "server/settings.ts", line: /if\(!\(action==="connect"\|\|action==="pair" \? authenticateCredential\(who, body\.get\("password"\)\?\?""\) : authenticateApprover\(who, body\.get\("password"\)\?\?""\)\)\.ok\) return show\("Enter your Toolroll password to change Discord access/ },
  { act: "pairing a phone (Telegram)", file: "server/settings.ts", line: /const pairingIdentity = authenticateAccount\(store, who\.name, body\.get\("password"\) \?\? ""\);/ },
  { act: "turning on approving from chat", file: "server/settings.ts", line: /const proved = authenticateAccount\(store, who\.name, body\.get\("token"\) \?\? ""\);/ },
  { act: "signing a mode with chat approval", file: "server/settings.ts", line: /if \(!\(body\.get\("chat-approve"\) === "1" \? authenticateCredential\(who, token\) : authenticateApprover\(who, token\)\)\.ok\)/ },
  // Project settings that widen what builds and checks reach (chat-management.md §0a.4).
  { act: "a project's network", file: "server/settings.ts", line: /if \(!authenticateCredential\(who, body\.get\("password"\) \?\? ""\)\.ok\) return back\("problem", "Enter your Toolroll password to change what builds may reach\."\);/ },
  { act: "where a project's builds may write", file: "server/settings.ts", line: /if \(!authenticateCredential\(who, body\.get\("password"\) \?\? ""\)\.ok\) return back\("problem", "Enter your Toolroll password to change where builds may write\."\);/ },
  { act: "a project's check access", file: "server/settings.ts", line: /const proved = authenticateCredential\(who, body\.get\("password"\) \?\? ""\);\n\s*if \(!proved\.ok\) return back\("problem", "Enter your Toolroll password to change how far checks reach\."\);/ },
  { act: "a project's sandbox", file: "server/settings.ts", line: /if \(!authenticateCredential\(who, body\.get\("password"\) \?\? ""\)\.ok\) return back\("problem", "Enter your Toolroll password to change the project's sandbox\."\);/ },
  { act: "turning Passwordless on", file: "server/settings.ts", line: /if \(!authenticateCredential\(who, body\.get\("password"\) \?\? ""\)\.ok\) return back\("problem", "Enter your Toolroll password to turn Passwordless on\."\);/ },
  { act: "CLI: runner register", file: "operate.ts", line: /fail\(write, json, "runner register", "usage"[^\n]*\n\s*\}\n\s*const authenticated = credentialApprover\(store, acting\.name, acting\.token\);/ },
  { act: "CLI: runner bind", file: "operate.ts", line: /fail\(write, json, "runner bind", "usage"[^\n]*\n\s*\}\n\s*const authenticated = credentialApprover\(store, acting\.name, acting\.token\);/ },
  { act: "CLI: coordinator mint", file: "operate.ts", line: /fail\(write, json, "coordinator mint", "usage"[^\n]*\n\s*\}\n\s*const authenticated = credentialApprover\(store, acting\.name, acting\.token\);/ },
  { act: "CLI: lead token (minting)", file: "operate.ts", line: /const verified = acting === null \? null : \(flags\.has\("revoke"\) \? authenticateApprover\(store, acting\.name, acting\.token\) : credentialApprover\(store, acting\.name, acting\.token\)\);/ },
  { act: "CLI: people invite and access", file: "operate.ts", line: /const authenticated = \(action === "revoke" \? authenticateApprover\(store, acting\.name, acting\.token\) : credentialApprover\(store, acting\.name, acting\.token\)\);/ },
  { act: "CLI: bridge pair", file: "operate.ts", line: /const authenticated = \(action === "pair" \? credentialApprover\(store, asWho, token\) : authenticateApprover\(store, asWho, token\)\);/ },
  { act: "CLI: chat-approval on", file: "operate.ts", line: /const authed = \(action === "on" \? credentialApprover\(store, acting\.name, acting\.token\) : authenticateApprover\(store, acting\.name, acting\.token\)\);/ },
  { act: "CLI: mode sign with chat approval", file: "operate.ts", line: /const authed = \(flag\(flags, "chat-approve"\) \? credentialApprover\(store, acting\.name, acting\.token\) : authenticateApprover\(store, acting\.name, acting\.token\)\);/ },
];

test.each(CREDENTIAL_ACTS)("$act proves with a typed password, never a session or the remembered login", ({ file, line }) => {
  expect(source(file)).toMatch(line);
});

test("the credential check refuses every passwordless proof", () => {
  const scope = source("scope.ts");
  expect(scope).toMatch(/export const credentialProof = \(method: AuthMethod\): boolean => method === "password-now" \|\| method === "sso-now";/);
  expect(source("server/guards.ts")).toMatch(/return !proved\.ok \|\| credentialProof\(proved\.method\) \? proved : \{ ok: false, reason: "not-an-approver" \};/);
  expect(source("operate.ts")).toMatch(/return !proved\.ok \|\| credentialProof\(proved\.method\) \? proved : \{ ok: false, reason: "not-an-approver" \};/);
});

test("the session reading lives in exactly one place", () => {
  const all = ["scope.ts", "server/guards.ts", "server/settings.ts", "server/people-tokens.ts", "operate.ts", "serve.ts"].map(source).join("\n");
  expect(all.match(/method: "session"/g) ?? []).toHaveLength(1);
  expect(all.match(/method: "cli-login"/g) ?? []).toHaveLength(1);
});
