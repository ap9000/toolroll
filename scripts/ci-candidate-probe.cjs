/**
 * What a hostile pull request would try, from inside a hardened CI job (docs/plans/trusted-release-reports.md, H1). The
 * trusted side (scripts/ci-candidate.mjs canary) runs this as the candidate's user by every road candidate code loads:
 * plainly, as a Tailwind `@plugin`, as an npm lifecycle script. Each attempt must be refused; each road writes what it
 * found to `<out>/<road>.json`, and a road that wrote nothing fails the canary too. CommonJS, with no imports of the
 * candidate's, so a Tailwind plugin can require it.
 */
const { spawn, spawnSync } = require("node:child_process");
const { appendFileSync, closeSync, openSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

/** Variables a job's token or the runner's file commands travel in. */
const CREDENTIAL_ENV = /^(ACTIONS_|GITHUB_|RUNNER_)|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
const CREDENTIAL_TEXT = /AUTHORIZATION|x-access-token|ghs_[A-Za-z0-9]/i;

const refusedWrite = (name, file) => {
  try { appendFileSync(file, ""); return { name, refused: false, detail: `${file} is writable` }; }
  catch (error) { return { name, refused: true, detail: error.code }; }
};
/** A file that reads is an escape only when it holds a credential; `strict`: one that reads at all is. */
const refusedRead = (name, file, strict) => {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (error) { return { name, refused: true, detail: error.code }; }
  return { name, refused: !strict && !CREDENTIAL_TEXT.test(text), detail: `${file} is readable` };
};

function attacks(config, env = process.env, identity = { uid: process.getuid(), gid: process.getgid(), groups: process.getgroups() }) {
  const found = [];
  found.push({ name: "runs as the candidate's user", refused: identity.uid === config.uid && identity.gid === config.gid, detail: `uid ${identity.uid}, gid ${identity.gid}` });
  found.push({ name: "holds no other group", refused: identity.groups.every(one => one === config.gid), detail: `groups ${identity.groups.join(",")}` });
  const leaked = Object.keys(env).filter(name => name !== "CANDIDATE_CANARY" && CREDENTIAL_ENV.test(name));
  found.push({ name: "no credential in its environment", refused: leaked.length === 0, detail: leaked.join(",") });
  found.push(refusedWrite("can't change the harness", config.harness));
  found.push(refusedWrite("can't change its own terms", config.state));
  found.push(refusedWrite("can't reach the runner's checkout", join(config.workspace, "package.json")));
  found.push(refusedWrite("can't reach the runner's file commands", join(config.temp, "_runner_file_commands", "probe")));
  found.push(refusedRead("no token in the checkout's Git config", join(config.workspace, ".git", "config"), false));
  found.push(refusedRead("can't read the runner's environment", `/proc/${config.runner}/environ`, true));
  let signal = { name: "can't signal the runner", refused: false, detail: `${config.runner} took a signal` };
  try { process.kill(config.runner, 0); } catch (error) { signal = { name: signal.name, refused: error.code === "EPERM" || error.code === "ESRCH", detail: error.code }; }
  found.push(signal);
  let socket = { name: "no Docker socket", refused: true, detail: "absent" };
  try { closeSync(openSync("/var/run/docker.sock", "r+")); socket = { name: socket.name, refused: false, detail: "/var/run/docker.sock opens" }; } catch (error) { socket = { ...socket, detail: error.code }; }
  found.push(socket);
  return found;
}

/**
 * The attempts that act on the machine as whoever runs them: only ever as the candidate's user on a disposable runner,
 * so `probe` refuses unless it is that user. (`crontab -` replaces the running user's whole crontab.)
 */
function machineAttacks() {
  const sudo = spawnSync("sudo", ["-n", "true"], { stdio: "ignore", timeout: 15_000 });
  const cron = spawnSync("crontab", ["-"], { input: "# candidate canary\n", stdio: ["pipe", "ignore", "ignore"], timeout: 10_000 });
  return [
    { name: "no sudo", refused: sudo.status !== 0, detail: `sudo ended ${String(sudo.status)}` },
    { name: "no scheduled job", refused: cron.status !== 0 || cron.error !== undefined, detail: `crontab ended ${String(cron.status)}` },
  ];
}

/** Runs the attempts, leaves a process that means to outlive the step, and writes what it found. */
function probe(route) {
  const config = JSON.parse(process.env.CANDIDATE_CANARY);
  if (process.getuid() !== config.uid) throw new Error("the probe runs only as the candidate's user");
  const stays = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3_600_000)"], { detached: true, stdio: "ignore" });
  stays.unref();
  writeFileSync(join(config.out, `${route}.json`), JSON.stringify({ route, attacks: [...attacks(config), ...machineAttacks()], left: [stays.pid] }));
}

module.exports = { attacks, probe };
if (require.main === module) probe(process.argv[2]);
