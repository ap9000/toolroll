/**
 * A stand-in for operate.ts's `runOperateAs` (the remote-principal seam) while it is not exported, so the remote CLI's
 * transport journey runs against a real server today. It is deliberately thin: read tokens may only read, step-up
 * commands are refused, a `--repo` outside the person's projects is refused and `task list` is limited to them;
 * everything else is the ordinary command on the same database. The real seam owns attribution and full policy.
 */
import { runOperate } from "../src/operate.js";
import { contractRow, STEP_UP_MESSAGE } from "../src/remote-exec.js";
import { envelopeJson } from "../src/envelope.js";
import type { RunOperateAs } from "../src/cli-http.js";

const STEP_UP = /^(task approve|approve|people|approver add|mode|chat-approval)/;

export function stubRunOperateAs(databaseFile: string): RunOperateAs {
  return async (argv, { principal, write }) => {
    const row = contractRow(argv), command = row?.invocation ?? argv[0] ?? "";
    const json = argv.includes("--json");
    const refuse = (reason: string, message: string) => { write(json ? envelopeJson({ ok: false, command, reason, message }) : message); return 3; };
    if (STEP_UP.test(command)) return refuse("step-up", STEP_UP_MESSAGE);
    if (principal.scope === "read" && row?.mutation !== "none") return refuse("read-only", "This API token can only read.");
    const at = argv.indexOf("--repo"), repo = at < 0 ? undefined : argv[at + 1];
    if (principal.projects !== null && repo !== undefined && !principal.projects.includes(repo)) return refuse("project-access", "You do not have access to that project.");
    const rest = argv.slice(1);
    if (principal.projects !== null && repo === undefined && command === "task list") rest.push("--repo", principal.projects[0] ?? "");
    return runOperate(argv[0] ?? "", rest, write, { databaseFile });
  };
}
