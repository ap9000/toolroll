/**
 * The code map's parser process (code-map-parse.ts): a static read of blobs Toolroll fetched, in its own process, with a
 * capped heap and output. It reads one JSON request on stdin and writes one JSON answer on stdout. `createSourceFile`
 * only: no Program, checker or plugin; nothing from the repository is imported or run; resolution is against the paths
 * in the request.
 */
import { compilerOptionsOf, extractFile, resolveAll } from "./code-extract.js";

type Request = { files: { path: string; text: string }[]; paths: string[]; tsconfig: string | null };
const ROOT = "/repo";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Request;
const compiler = (await import("typescript-parser")).default;
const normal = (file: string) => { const parts: string[] = []; for (const part of file.split("/")) { if (part === "" || part === ".") continue; if (part === "..") parts.pop(); else parts.push(part); } return `/${parts.join("/")}`; };
const known = new Map<string, { text?: string }>(request.paths.map(path => [`${ROOT}/${path}`, {}]));
for (const file of request.files) known.set(`${ROOT}/${file.path}`, { text: file.text });
if (request.tsconfig !== null) known.set(`${ROOT}/tsconfig.json`, { text: request.tsconfig });
const directories = new Set<string>([ROOT]);
for (const path of known.keys()) { let at = path.lastIndexOf("/"); while (at > ROOT.length) { const dir = path.slice(0, at); if (directories.has(dir)) break; directories.add(dir); at = dir.lastIndexOf("/"); } }
const { options, problem } = compilerOptionsOf(compiler, `${ROOT}/tsconfig.json`, request.tsconfig ?? undefined, ROOT);
const resolveOne = resolveAll(compiler, ROOT, known, directories, options, normal);
const facts = request.files.map(file => {
  const fileName = `${ROOT}/${file.path}`;
  const read = extractFile(compiler, fileName, file.text);
  return {
    path: file.path, parseFailed: read.parseFailed, exports: read.exports,
    specifiers: read.specifiers.map(one => { const to = resolveOne(one.specifier, fileName); return { specifier: one.specifier, kind: one.kind, line: one.line, to: to === null ? null : to.slice(ROOT.length + 1) }; }),
  };
});
process.stdout.write(`${JSON.stringify({ version: compiler.version, tsconfig: problem, facts })}\n`);
