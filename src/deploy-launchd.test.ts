// T22 (docs/plans/recovery-stops-silent-service.md): the strict readers the stop of a new service relies on. The sample
// is a scrubbed `launchctl print` block in launchd's own layout (tabs per level, path/state/arguments/pid in order);
// no output was captured from a real machine for it, and every name and path in it is made up.
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeRecorded, ownStateFolder, OWN_FOLDER_NAME, parseLaunchdPrint, programArguments, recordedLeft, treeOf, uncertain } from "../scripts/deploy-launchd.mjs";
import { fakePid } from "../test/fake-pid.js";

const TARGET = "gui/501/com.example.browser";
const PID = fakePid(1);
const ARGS = ["/usr/local/bin/node", "/opt/example/dist/controller-service.js", "/usr/local/bin/node", "/opt/example/dist/cli.js", "up", "--db", "/opt/example/state/orders.db"];
const SAMPLE = [
  `${TARGET} = {`,
  "\tactive count = 1",
  "\tpath = /opt/example/LaunchAgents/com.example.browser.plist",
  "\ttype = LaunchAgent",
  "\tstate = running",
  "",
  "\tprogram = /usr/local/bin/node",
  "\targuments = {",
  ...ARGS.map(arg => `\t\t${arg}`),
  "\t}",
  "",
  "\tworking directory = /opt/example/stage",
  "",
  "\tstdout path = /opt/example/stage/service.log",
  "\tstderr path = /opt/example/stage/service.log",
  "\tinherited environment = {",
  "\t\tSSH_AUTH_SOCK => /private/tmp/com.apple.launchd.example/Listeners",
  "\t}",
  "",
  "\tdefault environment = {",
  "\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin",
  "\t}",
  "",
  "\tenvironment = {",
  "\t\tXPC_SERVICE_NAME => com.example.browser",
  "\t}",
  "",
  "\tdomain = gui/501 [100005]",
  "\tasid = 100005",
  "\tminimum runtime = 10",
  "\texit timeout = 5",
  "\truns = 1",
  `\tpid = ${PID}`,
  "\timmediate reason = speculative",
  "\tforks = 0",
  "\texecs = 1",
  "\tinitialized = 1",
  "\ttrampolined = 1",
  "\tstarted suspended = 0",
  "\tproxy started suspended = 0",
  "\tlast exit code = (never exited)",
  "",
  "\tspawn type = daemon (3)",
  "\tjetsam priority = 40",
  "\tjetsam memory limit (active) = (unlimited)",
  "\tjetsam memory limit (inactive) = (unlimited)",
  "\tjetsam thread limit = 32",
  "\tcpumon = default",
  "\tjob state = running",
  "",
  "\tproperties = keepalive | runatload | inferred program",
  "}",
  "",
].join("\n");

describe("launchctl print, read strictly", () => {
  test("the scrubbed sample parses to its state, pid, path and arguments", () => {
    expect(parseLaunchdPrint(SAMPLE, TARGET)).toEqual({ state: "running", pid: PID, path: "/opt/example/LaunchAgents/com.example.browser.plist", arguments: ARGS });
    // A job loaded with no process prints no pid.
    expect(parseLaunchdPrint(SAMPLE.replace(`\tpid = ${PID}\n`, "").replace("state = running", "state = waiting"), TARGET)).toMatchObject({ state: "waiting", pid: null });
  });

  const swap = (from: string, to: string) => { expect(SAMPLE).toContain(from); return SAMPLE.replace(from, to); };
  const refused: [string, string, string?][] = [
    ["another target", SAMPLE, "gui/502/com.example.browser"],
    ["another label", SAMPLE, "gui/501/com.example.other"],
    ["a duplicate pid", swap(`\tpid = ${PID}\n`, `\tpid = ${PID}\n\tpid = ${fakePid(2)}\n`)],
    ["a duplicate path", swap("\ttype = LaunchAgent\n", "\ttype = LaunchAgent\n\tpath = /opt/example/other.plist\n")],
    ["a duplicate state", swap("\tstate = running\n", "\tstate = running\n\tstate = running\n")],
    ["a duplicate arguments block", swap("\tworking directory", "\targuments = {\n\t\t/bin/sh\n\t}\n\tworking directory")],
    ["a nested pid", swap("\t\tXPC_SERVICE_NAME => com.example.browser\n", `\t\tXPC_SERVICE_NAME => com.example.browser\n\t\tpid = ${fakePid(3)}\n`)],
    ["a nested path", swap("\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin\n", "\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin\n\t\tpath = /opt/example/other.plist\n")],
    ["a nested state", swap("\t\tSSH_AUTH_SOCK", "\t\tstate = running\n\t\tSSH_AUTH_SOCK")],
    ["a nested arguments block", swap("\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin\n", "\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin\n\t\targuments = {\n\t\t\t/bin/sh\n\t\t}\n")],
    ["a block inside the arguments", swap("\t\tup\n", "\t\tup = {\n\t\t}\n")],
    ["a truncated block", SAMPLE.slice(0, SAMPLE.indexOf("\tspawn type"))],
    ["an unclosed arguments block", swap("\t\t/opt/example/state/orders.db\n\t}\n", "\t\t/opt/example/state/orders.db\n")],
    ["an extra closing brace", swap("\tproperties", "}\n\tproperties")],
    ["text after the block", `${SAMPLE}gui/501/com.example.browser = {\n}\n`],
    ["pid before state", swap("\tstate = running\n", `\tpid = ${PID}\n\tstate = running\n`).replace(`\truns = 1\n\tpid = ${PID}\n`, "\truns = 1\n")],
    ["arguments before path", swap("\tpath = /opt/example/LaunchAgents/com.example.browser.plist\n", "").replace("\tworking directory", "\tpath = /opt/example/LaunchAgents/com.example.browser.plist\n\tworking directory")],
    ["a space for a tab", swap("\tstate = running", "    state = running")],
    ["a tab too many", swap("\tstate = running", "\t\tstate = running")],
    ["trailing whitespace", swap("\tstate = running", "\tstate = running ")],
    ["two spaces around the equals sign", swap("\tstate = running", "\tstate  =  running")],
    ["a pid that is not a number", swap(`\tpid = ${PID}`, `\tpid = ${PID}x`)],
    ["pid 1", swap(`\tpid = ${PID}`, "\tpid = 1")],
    ["a pid with a leading zero", swap(`\tpid = ${PID}`, `\tpid = 0${PID}`)],
    ["no path", swap("\tpath = /opt/example/LaunchAgents/com.example.browser.plist\n", "")],
    ["no state", swap("\tstate = running\n", "")],
    ["no arguments", swap(`\targuments = {\n${ARGS.map(arg => `\t\t${arg}\n`).join("")}\t}\n`, "")],
    ["empty arguments", swap(`\targuments = {\n${ARGS.map(arg => `\t\t${arg}\n`).join("")}\t}\n`, "\targuments = {\n\t}\n")],
    ["CRLF line ends", SAMPLE.replaceAll("\n", "\r\n")],
  ];
  test.each(refused)("refuses %s", (_name, text, target = TARGET) => {
    expect(parseLaunchdPrint(text, target)).toBeNull();
  });
  test("refuses what is not text", () => {
    for (const value of [null, undefined, 7, Buffer.from(SAMPLE)]) expect(parseLaunchdPrint(value as never, TARGET)).toBeNull();
  });
});

describe("ProgramArguments, read strictly", () => {
  const plist = (array: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>Label</key>\n\t<string>com.example.browser</string>\n\t<key>ProgramArguments</key>\n\t<array>\n${array}\n\t</array>\n</dict>\n</plist>\n`;
  const entries = (args: string[]) => args.map(arg => `\t\t<string>${arg}</string>`).join("\n");
  test("reads the array, with the five XML entities", () => {
    expect(programArguments(plist(entries(ARGS)))).toEqual(ARGS);
    expect(programArguments(plist(entries(["/bin/echo", "a &amp; b", "&lt;x&gt;", "&quot;q&quot;", "&apos;s&apos;"])))).toEqual(["/bin/echo", "a & b", "<x>", "\"q\"", "'s'"]);
  });
  const refused: [string, string][] = [
    ["a duplicate key", plist(entries(ARGS)).replace("</dict>", "\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>/bin/sh</string>\n\t</array>\n</dict>")],
    ["no key", plist(entries(ARGS)).replace("<key>ProgramArguments</key>", "<key>Arguments</key>")],
    ["a nested array", plist(`${entries(ARGS)}\n\t\t<array>\n\t\t\t<string>x</string>\n\t\t</array>`)],
    ["another element", plist(`${entries(ARGS)}\n\t\t<integer>3</integer>`)],
    ["an unknown entity", plist(entries(["/bin/echo", "&nbsp;"]))],
    ["a bare ampersand", plist(entries(["/bin/echo", "a & b"]))],
    ["an entity without its semicolon", plist(entries(["/bin/echo", "&amp b"]))],
    ["an argument with a line break", plist(entries(["/bin/echo", "one\ntwo"]))],
    ["an empty argument", plist(entries(["/bin/echo", ""]))],
    ["an empty array", plist("")],
    ["an unclosed array", plist(entries(ARGS)).replace("\t</array>", "")],
    ["no array", plist(entries(ARGS)).replace("\t<array>", "")],
  ];
  test.each(refused)("refuses %s", (_name, text) => {
    expect(programArguments(text)).toBeNull();
  });
});

describe("process trees and recorded processes", () => {
  const START = "Mon Nov 9 10:00:00 2026", LATER = "Mon Nov 9 10:05:00 2026";
  const [a, b, c, d, e, f] = [1, 2, 3, 4, 5, 6].map(n => fakePid(n));
  const rows = [
    { pid: 1, ppid: 0, start: START, command: "/sbin/launchd" },
    { pid: a!, ppid: 1, start: START, command: "supervisor" },
    { pid: b!, ppid: a!, start: START, command: "up" },
    { pid: c!, ppid: b!, start: START, command: "console" },
    { pid: d!, ppid: c!, start: START, command: "helper" },
    { pid: f!, ppid: 1, start: START, command: "unrelated" },
  ];
  test("a tree three levels below its root is whole; a fourth level or a missing root is not", () => {
    expect(treeOf(rows, a!)).toEqual([a, b, c, d].map(pid => ({ pid, start: START })));
    expect(treeOf([...rows, { pid: e!, ppid: d!, start: START, command: "too deep" }], a!)).toBeNull();
    expect(treeOf(rows, fakePid(9))).toBeNull();
    expect(treeOf(null as never, a!)).toBeNull();
  });
  test("a recorded process is gone only when no process has its pid with its start time", () => {
    const recorded = [{ pid: b!, start: START }];
    expect(recordedLeft(rows, recorded)).toEqual([`process ${b}`]);
    // Reused: the same pid with another start time is another process; the recorded one exited.
    expect(recordedLeft(rows.map(row => row.pid === b ? { ...row, start: LATER } : row), recorded)).toEqual([]);
    expect(recordedLeft(rows.filter(row => row.pid !== b), recorded)).toEqual([]);
    // What is not a pid and a start time never proves anything.
    for (const bad of [{ pid: b }, { pid: 1, start: START }, { pid: "x", start: START }, null]) expect(recordedLeft([], [bad])).toEqual(["an unreadable recorded process"]);
    expect(recordedLeft(null as never, recorded)).toEqual(["the process list could not be read"]);
    expect(recordedLeft(rows, "garbage" as never)).toEqual(["the recorded processes are unreadable"]);
  });
  test("an earlier record's processes are kept beside the new ones", () => {
    expect(mergeRecorded([{ pid: a, start: START }, { pid: b, start: START }], [{ pid: b, start: START }, { pid: c, start: START }])).toEqual([a, b, c].map(pid => ({ pid, start: START })));
  });
});

describe("the rest of what the stop reads", () => {
  test("a call's outcome is known only with a numeric status and no error or signal", () => {
    expect(uncertain({ status: 0, stdout: "" })).toBe(false);
    expect(uncertain({ status: 113, signal: null, error: undefined })).toBe(false);
    for (const out of [null, {}, { status: null, signal: "SIGTERM" }, { status: null, error: Object.assign(Error("spawnSync /bin/launchctl ETIMEDOUT"), { code: "ETIMEDOUT" }) }, { status: 0, error: Error("ENOENT") }]) expect(uncertain(out)).toBe(true);
  });
  test("a state folder is Toolroll's own by the agent fence's own name test", () => {
    const fence = readFileSync(join(import.meta.dirname, "agent-fence.ts"), "utf8");
    expect(fence).toContain(`${OWN_FOLDER_NAME.source}/i.test(basename(state))`);
    const root = mkdtempSync(join(tmpdir(), "own-folder-"));
    for (const [name, own] of [["toolroll", true], ["standing-orders", true], ["Nightorders", true], ["projects", false]] as const) {
      const folder = join(root, name);
      mkdirSync(folder);
      expect([name, ownStateFolder(folder, join(root, "home"))]).toEqual([name, own]);
    }
    expect(ownStateFolder(join(root, "toolroll"), join(root, "toolroll"))).toBe(false);
    mkdirSync(join(root, "toolroll", ".git"));
    expect(ownStateFolder(join(root, "toolroll"), join(root, "home"))).toBe(false);
  });
});
