/**
 * Properties of the agent's last words (agent-said.ts), over generated output: escapes and controls, folders on this
 * computer, web addresses with userinfo, queries and fragments, key-shaped tokens and long lines, in any mix and next
 * to any separator. Each planted secret carries a unique tag that must not survive; each rule is checked by shape too.
 */
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { AGENT_SAID_CHARS, AGENT_SAID_LINES, agentSaidTail } from "./agent-said.js";
import { PROPERTY } from "../test/property.js";

/** One piece of an agent's output, and the tags that must never come out. */
type Piece = { text: string; secret: string[] };

const seg = fc.stringMatching(/^[A-Za-z0-9._-]{1,10}$/);
const SEPARATORS = [" ", "  ", "\n", "\r\n", "\t", '"', "'", "`", "(", "<", "=", ",", ":"];
const URL_ENDS = [" ", "  ", "\n", "\r\n", "\t", '"', "'", "`", "<"];

/** A folder on this computer, in every form the rule names (the tag in a folder name). */
const folder = (tag: string): fc.Arbitrary<Piece> => fc.tuple(seg, fc.constantFrom("/Users/me", "/home/me", "/root", "/opt", "/private/tmp", "/var/folders/x", "~", "~sam", "~me.dev", "C:\\Users\\me", "d:", "/")).map(([name, root]) => {
  const sep = root.startsWith("C:") ? "\\" : "/";
  const text = root === "/" ? `/${tag}.${name}` : `${root}${sep}${tag}${sep}${name}`;
  return { text, secret: [tag] };
});
/** A web address whose query and fragment carry the tag. */
const address = (tag: string): fc.Arbitrary<Piece> => fc.tuple(fc.constantFrom("https", "http", "git+ssh", "s3"), seg, fc.constantFrom("?", "#", "?a=1#")).map(([scheme, path, mark]) =>
  ({ text: `${scheme}://host.example/${path}${mark}q${tag}=1`, secret: [`q${tag}`] }));
/** A web address with userinfo carrying the tag. */
const userinfo = (tag: string): fc.Arbitrary<Piece> => fc.tuple(fc.constantFrom("https", "ftp"), fc.boolean()).map(([scheme, password]) => password
  ? { text: `${scheme}://u${tag}:p${tag}w@host.example/x`, secret: [`u${tag}`, `p${tag}w`] }
  // A name alone (no password: no key scan sees it).
  : { text: `${scheme}://u${tag}@host.example/x`, secret: [`u${tag}`] });
/** Two folders glued by a character a path can start after: the second is a folder of its own, never a tail. */
const glued = (tag: string): fc.Arbitrary<Piece> => fc.tuple(folder(`${tag}a`), fc.constantFrom("(", "<", "=", "[", ","), folder(`${tag}b`))
  .map(([first, glue, second]) => ({ text: `${first.text}${glue}${second.text}`, secret: [...first.secret, ...second.secret] }));
/** Escapes, controls and bidi marks. (Not a sequence cut off after its `ESC [`: that one eats the next character, which
 * can be a path's first slash; what is left is no longer a path, so the shape rule holds, but its tag would not.) */
const escapes: fc.Arbitrary<Piece> = fc.constantFrom(
  "\u001b[31m", "\u001b[0m", "\u001b[2J\u001b[H", "\u001b]0;title\u0007", "\u001b]8;;https://x.example\u001b\\link\u001b]8;;\u001b\\", "\u001b", "\u009b31m",
  "\u0000", "\u0007", "\u0008", "\u000b", "\u000c", "\u007f", "\u0085", "\u061c", "\u200b", "\u200e", "\u200f", "\u202a", "\u202b", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069",
).map(text => ({ text, secret: [] }));
/** Anything at all, short, a long line, and one about as long as a line may be. */
const filler: fc.Arbitrary<Piece> = fc.oneof(fc.string({ unit: "grapheme", maxLength: 30 }), fc.string({ unit: "binary", maxLength: 20 }), fc.string({ unit: "grapheme-ascii", minLength: 150, maxLength: 420 }), fc.string({ unit: "grapheme-ascii", minLength: 195, maxLength: 215 }))
  .map(text => ({ text, secret: [] }));

/** An agent's output: pieces, each tagged uniquely, between separators. */
const output: fc.Arbitrary<{ text: string; secret: string[] }> = fc.array(fc.tuple(fc.nat(5), fc.constantFrom(...SEPARATORS), fc.stringMatching(/^[a-z0-9]{4}$/)), { maxLength: 24 })
  .chain(plan => fc.tuple(...plan.map(([kind, chosen, salt], at) => {
    const tag = `t${at}k${salt}`;
    // Right after a web address, "=", ":", "," or "(" belong to it (a path or query may hold them): the next piece is
    // part of the address, not a piece of its own. A space, a tab, a line break, a quote or an angle bracket ends it.
    const afterAddress = at > 0 && (plan[at - 1]![0] === 1 || plan[at - 1]![0] === 2);
    const sep = afterAddress && !URL_ENDS.includes(chosen) ? " " : chosen;
    const piece = [folder, address, userinfo, () => escapes, () => filler, glued][kind]!(tag);
    return piece.map(one => ({ ...one, text: `${sep}${one.text}` }));
  })))
  .map(pieces => ({ text: pieces.map(one => one.text).join(""), secret: pieces.flatMap(one => one.secret) }));

/** One line, longer than a line may be, whose web address (its query hidden) ends right at the cut, give or take two:
 * the cut lands in the query, on its end, or on the space after it. */
const nearCut = fc.tuple(seg, fc.integer({ min: -3, max: 2 }), fc.constantFrom("a", "b", "-")).map(([path, shift, letter]) => {
  const hidden = `https://host.example/${path}?[hidden]`;
  const words = letter.repeat(Math.max(1, AGENT_SAID_CHARS - 2 - hidden.length + shift));
  return { text: `${words} https://host.example/${path}?qt0kcut0=1 and more after it`, secret: ["qt0kcut0"] };
});

/** More lines than are kept, short and long. */
const manyLines = fc.array(fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 230 }), { minLength: 9, maxLength: 30 })
  .map(lines => ({ text: lines.join("\n"), secret: [] as string[] }));

/** One long line with characters outside the BMP (two UTF-16 units each) where the cut lands. */
const astralCut = fc.tuple(fc.integer({ min: 190, max: 200 }), fc.constantFrom("\u{10000}", "\u{1f600}", "\u{20000}")).map(([at, wide]) =>
  ({ text: `${"a".repeat(at)}${wide.repeat(6)} and more`, secret: [] as string[] }));

/** A web address as the rule reads one: a scheme, `://`, up to a space, a quote or an angle bracket. */
const ADDRESS = /[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]*/gi;
/** A folder on this computer where a path can start: two or more named parts from the root ("/tmp/" alone, like a
 * "/login" command, is not one; a part holds none of the characters a path can start after), a home (`~/`, `~name/`),
 * a drive. */
const PART = "[^\\s\"'\u0060()<>[\\]/:,;=]";
const FOLDER = new RegExp(`(?:^|[\\s"'\u0060(<[=:,])(?:\\/${PART}+\\/${PART}|~[A-Za-z0-9._-]*\\/|[A-Za-z]:[\\\\/])`);
/** Control characters (Cc), and the bidi controls (Bidi_Control: ALM, LRM, RLM, the embeddings, overrides and isolates). */
const CONTROL = /[\p{Cc}\p{Bidi_Control}]/u;

describe("the agent's last words, for any output", () => {
  test("cleaning twice is cleaning once", () => {
    fc.assert(fc.property(fc.oneof(output, nearCut), ({ text }) => {
      const once = agentSaidTail(text);
      expect(agentSaidTail(once.join("\n"))).toEqual(once);
    }), PROPERTY);
  });

  test("no folder on this computer, no query or fragment, no userinfo: by shape and by every planted tag", () => {
    fc.assert(fc.property(fc.oneof(output, nearCut), ({ text, secret }) => {
      const lines = agentSaidTail(text);
      const all = lines.join("\n");
      for (const tag of secret) expect(all, tag).not.toContain(tag);
      for (const line of lines) {
        expect(line.replace(ADDRESS, " "), line).not.toMatch(FOLDER);
        for (const [url] of line.matchAll(ADDRESS)) {
          const info = /^[a-z][a-z0-9+.-]*:\/\/([^\s/@"'`<>]+)@/i.exec(url);
          if (info !== null) expect(info[1], url).toBe("[hidden]");
          const at = url.search(/[?#]/);
          if (at === -1) continue;
          const rest = url.slice(at);
          // Hidden whole; or cut short at the line's limit, a start of the same words.
          expect(rest === "?[hidden]" || (rest.endsWith("…") && "?[hidden]".startsWith(rest.slice(0, -1))), url).toBe(true);
        }
      }
    }), PROPERTY);
  });

  test(`at most ${AGENT_SAID_LINES} lines of at most ${AGENT_SAID_CHARS} characters, none blank, with no control, escape or bidi character`, () => {
    fc.assert(fc.property(fc.oneof(output, astralCut, manyLines), ({ text }) => {
      const lines = agentSaidTail(text);
      expect(lines.length).toBeLessThanOrEqual(AGENT_SAID_LINES);
      for (const line of lines) {
        expect(line.length, line).toBeLessThanOrEqual(AGENT_SAID_CHARS);
        expect(line.trim(), line).not.toBe("");
        expect(CONTROL.test(line), JSON.stringify(line)).toBe(false);
        // Cut to length, never between the halves of a character outside the BMP.
        if (text.isWellFormed()) expect(line.isWellFormed(), JSON.stringify(line)).toBe(true);
      }
    }), PROPERTY);
  });
});
