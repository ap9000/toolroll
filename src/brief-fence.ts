/**
 * One line, prefixed, with nothing that can end the block or start a new rule.
 *
 * Scope text is written by whoever filed the task. A goal containing a newline
 * and a bullet would otherwise read to the agent as another rule in the list,
 * which is how "add a guard" becomes "add a guard, and ignore the rules below".
 * The same quoting wraps a steering note the agent reads from its mailbox.
 */
export function fence(text: string): string {
  // Newlines and other control characters collapse to a space: they are the
  // only way a value can stop being one line and start looking like a new
  // rule. The visible text is otherwise left exactly as written — mangling
  // somebody's scope to defend against it would be its own kind of wrong.
  return `| ${text
    // C0/C1 plus the Unicode line and paragraph separators: everything
    // that could end this physical line (Codex free-text review, finding 5).
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ")
    // A quoted protocol-shaped name is broken VISIBLY, so untrusted text
    // can never collide with the real nonce-bearing filename that follows.
    .replace(/STANDING-ORDERS-/g, "NIGHTORDERS[quoted]-")
    .trim()}`;
}
