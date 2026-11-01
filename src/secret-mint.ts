/**
 * Secrets a person types or pastes on a command line (passwords, invite and approver tokens, runner credentials):
 * random base64url, never starting with "-". A value starting with "--" reads as a flag to many parsers (`--token
 * --abc…` was refused as a missing value: about 1 in 4096 minted passwords), so it is drawn again. The CLI accepts one
 * anyway (an older secret), but a new one never needs that.
 */
import { randomBytes } from "node:crypto";

export function mintSecret(bytes: number, draw: (size: number) => Buffer = randomBytes): string {
  for (;;) {
    const secret = draw(bytes).toString("base64url");
    if (!secret.startsWith("-")) return secret;
  }
}
