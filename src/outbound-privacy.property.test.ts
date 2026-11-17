/**
 * Properties of the outbound privacy rule (outbound-privacy.ts): whatever words surround it, a message that carries a
 * folder on this computer or a key from the generated corpus is never allowed out as written, in any field, as the chat
 * app will show it, or cut across chunks; and the safe version that goes instead is itself allowed.
 */
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { checkedChunks, privateValue, privateWords, safeMail, safeWords } from "./outbound-privacy.js";
import { PROPERTY } from "../test/property.js";

const chars = (alphabet: string, min: number, max: number) => fc.array(fc.constantFrom(...alphabet), { minLength: min, maxLength: max }).map(one => one.join(""));
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** base64url: keys and tokens use `-` and `_` anywhere, the last character too. */
const URLSAFE = `${ALNUM}_-`;
/** A base64url body of `min`..`max` characters whose last one is often `-` or `_` (the edge a `\b` misses). */
const urlsafe = (min: number, max: number) => fc.tuple(chars(URLSAFE, min - 1, max - 1), fc.constantFrom("-", "_", "-", "a", "Z", "9")).map(([body, last]) => `${body}${last}`);
const name = fc.stringMatching(/^[a-z][a-z0-9._-]{0,11}$/);

/** A folder on this computer: a home (macOS, Linux, root, `~`), a drive, a network share, a file URL. */
const folder = fc.tuple(name, name).chain(([user, part]) => fc.constantFrom(
  `/Users/${user}/${part}`, `/home/${user}/${part}`, `/root/${part}`, `~/${part}`, `C:\\Users\\${user}\\${part}`, `d:/${part}`, `\\\\${user}\\${part}`, `file:///${part}`,
));
/** A key or token in the shape its issuer gives it. */
const key = fc.oneof(
  chars(UPPER, 16, 16).map(body => `AKIA${body}`),
  chars(ALNUM, 36, 36).map(body => `ghp_${body}`),
  chars(`${ALNUM}_`, 22, 60).map(body => `github_pat_${body}`),
  fc.tuple(chars("0123456789", 6, 13), chars("0123456789", 6, 13), chars(ALNUM, 24, 24)).map(([team, bot, body]) => `xoxb-${team}-${bot}-${body}`),
  urlsafe(32, 90).map(body => `sk-${body}`),
  urlsafe(32, 90).map(body => `sk-proj-${body}`),
  chars(ALNUM, 24, 40).map(body => `sk_live_${body}`),
  urlsafe(35, 35).map(body => `AIza${body}`),
  urlsafe(20, 20).map(body => `glpat-${body}`),
  fc.tuple(chars("0123456789", 8, 10), urlsafe(33, 33)).map(([id, body]) => `${id}:AA${body}`),
  fc.constantFrom("-----BEGIN OPENSSH PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----"),
  fc.tuple(name, chars(ALNUM, 6, 20)).map(([user, pass]) => `https://${user}:${pass}@git.company.dev/repo.git`),
);
const secret = fc.oneof(folder, key);
/** Ordinary words around it: any text, kept off the secret by a separator. */
const words = fc.string({ unit: "grapheme", maxLength: 40 });
const separator = fc.constantFrom(" ", "\n", "\t", "(", '"', "'", "`", "=", ",", ": ");
const message = fc.tuple(words, separator, secret, separator, words).map(([before, open, hidden, close, after]) => ({ text: `${before}${open}${hidden}${close}${after}`, hidden }));

describe("the outbound privacy rule, for any message", () => {
  test("a message naming a folder on this computer or a key is never allowed as written", () => {
    fc.assert(fc.property(message, ({ text }) => {
      expect(privateWords(text), text).toBe(true);
    }), PROPERTY);
  });

  test("in any field of a message body, and as a chat app shows it after Markdown escaping", () => {
    fc.assert(fc.property(message, fc.constantFrom("text", "caption", "url", "title"), ({ text }, field) => {
      expect(privateValue({ chat_id: 1, reply_markup: { inline_keyboard: [[{ [field]: text }]] } })).toBe(true);
      // Discord's escaping (a backslash before each Markdown character) doesn't hide it either.
      expect(privateValue({ content: text.replace(/[\\*_~`|>#[\]()-]/g, "\\$&") })).toBe(true);
    }), PROPERTY);
  });

  test("cut across chunks anywhere, the whole message is checked and goes as its safe version", () => {
    fc.assert(fc.property(message, fc.nat(), ({ text }, at) => {
      const cut = at % (text.length + 1);
      const chunks = checkedChunks(text, [text.slice(0, cut), text.slice(cut)], { project: "/Users/me/shop" });
      expect(chunks).toEqual([safeWords({ project: "/Users/me/shop" })]);
      expect(chunks.some(privateWords)).toBe(false);
    }), PROPERTY);
  });

  test("what an email sends instead is itself allowed, whatever the project is called", () => {
    fc.assert(fc.property(message, fc.oneof(fc.constant(null), folder, fc.string({ maxLength: 60 })), ({ text }, project) => {
      const sent = safeMail({ subject: "Result", text, to: "me@example.com" }, { project });
      expect(privateWords(sent.subject) || privateWords(sent.text)).toBe(false);
      expect(sent.text).not.toContain(text);
    }), PROPERTY);
  });
});
