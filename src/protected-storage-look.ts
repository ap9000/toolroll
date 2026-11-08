/**
 * The storage check's child process (protected-storage.ts prepareProtectedStorage): it finds the protected roots, reads
 * Firefox's profiles.ini and walks every present root here, where a listing that waits on a macOS privacy prompt holds
 * up only this process. It writes `at\t<root>` before each walk and `done\t<answer>` at the end; the parent kills it at
 * its limit and refuses the launch.
 */
import { protectedStorageHere } from "./protected-storage.js";

const request = JSON.parse(process.argv[2] ?? "{}") as { home?: unknown; env?: unknown; platform?: unknown };
if (typeof request.home !== "string" || typeof request.platform !== "string" || request.env === null || typeof request.env !== "object") process.exit(2);
const env = Object.fromEntries(Object.entries(request.env as Record<string, unknown>).filter((one): one is [string, string] => typeof one[1] === "string"));
const answer = protectedStorageHere(request.home, env, request.platform as NodeJS.Platform, () => {}, undefined, root => { process.stdout.write(`at\t${JSON.stringify(root)}\n`); });
process.stdout.write(`done\t${JSON.stringify(answer)}\n`);
