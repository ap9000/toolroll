/**
 * How a Linux build with a network of its own reaches its proxy and tool broker (agent-fence.ts linuxFenced). The
 * plane serves one unix socket per port in a folder of its own (`<folder>/<port>.sock`, each relayed to that port on
 * the host's loopback); bubblewrap binds the folder read-only into the build's namespace, where the forwarder below
 * listens on the namespace's own 127.0.0.1 at the same ports and relays each connection to its socket. Only those
 * ports cross: nothing else of the host's network is reachable, and the relay never opens a connection of its own.
 *
 * The forwarder is written into the folder at launch (the plane's own file, read-only to the build), so it never runs
 * from an installation path a fence might hide or a build could change.
 */
import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The prefix of a bridge folder in the temp folder (agent-fence.ts RUN_FOLDER_PREFIXES denies every other run's). */
export const BRIDGE_PREFIX = "so-net-";

/** The forwarder, run inside the namespace as `node forward.mjs <folder> <port>... -- <command>`. Zero dependencies. */
export const FORWARDER_SOURCE = String.raw`import { connect, createServer } from "node:net";
import { spawn } from "node:child_process";
const argv = process.argv.slice(2);
const split = argv.indexOf("--");
if (split < 1 || split === argv.length - 1) { process.stderr.write("toolroll forwarder: usage <folder> <port>... -- <command>\n"); process.exit(2); }
const folder = argv[0];
const ports = argv.slice(1, split).map(Number);
const command = argv.slice(split + 1);
let ready = 0;
for (const port of ports) {
  const server = createServer(client => {
    const upstream = connect(folder + "/" + port + ".sock");
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.on("error", error => { process.stderr.write("toolroll forwarder: " + error.message + "\n"); process.exit(70); });
  server.listen(port, "127.0.0.1", () => { if (++ready === ports.length) start(); });
}
if (ports.length === 0) start();
function start() {
  const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", error => { process.stderr.write("toolroll forwarder: " + error.message + "\n"); process.exit(127); });
  child.on("exit", (code, signal) => {
    if (signal === null) process.exit(code ?? 1);
    // Die the way the agent died: this process's own handlers (which only pass a signal on) step aside first.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    setTimeout(() => process.exit(128), 1000).unref();
  });
}
`;

/** The longest a unix socket's path may be here (macOS 104 bytes, Linux 108, with room to spare). */
const SOCKET_PATH_MAX = 100;
/** Whether a bridge made under `root` keeps every socket path within the limit (its folder and `<port>.sock`). */
export function bridgeFits(root: string): boolean {
  return join(root, `${BRIDGE_PREFIX}XXXXXX`, "65535.sock").length <= SOCKET_PATH_MAX;
}

export type EgressBridge = { folder: string; forwarder: string; close: () => Promise<void> };

/**
 * Serve one socket per port (each relayed to that port on the host's loopback) in a fresh owner-only folder under
 * `root`: the plane's own bridge folder beside the database (agent-fence.ts BRIDGE_DIR), which every build's fence
 * hides from launch, so no other build can change the forwarder or reach the sockets.
 */
export async function startEgressBridge(ports: readonly number[], root: string = tmpdir()): Promise<EgressBridge> {
  // The root must be a real folder of this user's alone, never a link a build could have planted before it existed.
  const held = lstatSync(root);
  if (held.isSymbolicLink() || !held.isDirectory() || (process.getuid !== undefined && held.uid !== process.getuid()) || (root !== tmpdir() && (held.mode & 0o077) !== 0)) {
    throw new Error(`the bridge folder ${root} isn't a private folder of this user's`);
  }
  if (!bridgeFits(root)) throw new Error(`the bridge folder ${root} is too deep for a socket path`);
  const folder = mkdtempSync(join(root, BRIDGE_PREFIX));
  chmodSync(folder, 0o700);
  const forwarder = join(folder, "forward.mjs");
  writeFileSync(forwarder, FORWARDER_SOURCE, { mode: 0o500, flag: "wx" });
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  try {
    for (const port of ports) {
      const server = createServer(client => {
        sockets.add(client);
        const upstream = connect(port, "127.0.0.1");
        sockets.add(upstream);
        const drop = () => { client.destroy(); upstream.destroy(); };
        client.on("error", drop); upstream.on("error", drop);
        client.on("close", () => { sockets.delete(client); upstream.destroy(); });
        upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
        client.pipe(upstream);
        upstream.pipe(client);
      });
      await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(join(folder, `${port}.sock`), () => { server.off("error", fail); done(); }); });
      servers.push(server);
    }
  } catch (error) {
    for (const server of servers) server.close();
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
  return {
    folder,
    forwarder,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map(server => new Promise<void>(done => server.close(() => done()))));
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
