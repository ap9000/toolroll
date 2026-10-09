/**
 * Both CLI names, moved to a deployed runtime (release.ts, step `link`): `toolroll` and `standing-orders` are pointed
 * at `<runtime>/bin.js`, each link replaced whole (a new link renamed over the old one). Each name must then resolve to
 * that file and answer with the released version, or every link goes back to where it pointed before.
 *
 * The coordinator saves what `findCliLinks` saw before switching, so a release killed halfway through relinking still
 * knows where to put each name back. A name on PATH that is a file rather than a link is someone else's and never
 * replaced.
 */

import { randomUUID } from "node:crypto";
import { lstatSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

export const CLI_NAMES = Object.freeze(["toolroll", "standing-orders"] as const);

/** One name on PATH: where its link is and what it pointed at before the release (null: not there yet). */
export type CliLink = { name: string; path: string; before: string | null; foreign?: true };

/** Where each name is on PATH. A missing name is made beside the other one; none on PATH at all is an empty list. */
export function findCliLinks(path = process.env["PATH"] ?? "", names: readonly string[] = CLI_NAMES): CliLink[] {
  const found = names.map((name): { name: string; path: string | null; before: string | null; foreign?: true } => {
    for (const dir of path.split(delimiter).filter(Boolean)) {
      const at = join(dir, name);
      let entry;
      try { entry = lstatSync(at); } catch { continue; }
      if (!entry.isSymbolicLink()) return { name, path: at, before: null, foreign: true };
      return { name, path: at, before: resolve(dirname(at), readlinkSync(at)) };
    }
    return { name, path: null, before: null };
  });
  const home = found.find(one => one.path !== null && one.foreign === undefined);
  if (home === undefined) return found.filter((one): one is CliLink => one.path !== null);
  return found.map(one => ({ ...one, path: one.path ?? join(dirname(home.path!), one.name) }));
}

/** Point `link` at `target`, atomically: a new link beside it, renamed over it. */
export function pointLink(link: string, target: string): void {
  const temp = `${link}.${randomUUID().slice(0, 8)}.link`;
  symlinkSync(target, temp);
  try { renameSync(temp, link); } catch (error) { rmSync(temp, { force: true }); throw error; }
}

const target = (link: string): string | null => { try { return resolve(dirname(link), readlinkSync(link)); } catch { return null; } };
const real = (path: string): string | null => { try { return realpathSync(path); } catch { return null; } };

/**
 * Switch every link to `bin`. `answers(path)` says whether that name now answers as the released build. Any failure
 * puts every link back where `links` says it was, and throws. Switching a link already at `bin` changes nothing, so a
 * resumed relink repeats safely.
 */
export function switchCliLinks(links: readonly CliLink[], bin: string, answers: (path: string) => boolean): CliLink[] {
  const foreign = links.find(one => one.foreign === true);
  if (foreign !== undefined) throw new Error(`${foreign.path} is not a link; it was left as it is`);
  if (links.length < CLI_NAMES.length) throw new Error(`found ${links.length === 0 ? "no CLI name" : `only ${links.map(one => one.name).join(", ")}`} on PATH; link both with \`toolroll link\` first`);
  const wanted = real(bin);
  if (wanted === null) throw new Error(`${bin} does not exist`);
  try {
    for (const link of links) if (target(link.path) !== bin) pointLink(link.path, bin);
    for (const link of links) {
      if (real(link.path) !== wanted) throw new Error(`${link.path} does not resolve to ${bin}`);
      if (!answers(link.path)) throw new Error(`${link.path} does not answer as the released build`);
    }
    return links.map(({ name, path, before }) => ({ name, path, before }));
  } catch (error) {
    restoreCliLinks(links);
    throw error;
  }
}

/** Each link where it pointed before; a link that wasn't there before is removed. */
export function restoreCliLinks(links: readonly CliLink[]): void {
  for (const link of links) {
    if (link.foreign === true) continue;
    if (link.before === null) rmSync(link.path, { force: true });
    else if (target(link.path) !== link.before) pointLink(link.path, link.before);
  }
}
