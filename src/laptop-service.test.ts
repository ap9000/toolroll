/**
 * The laptop-mode login item: unit text asserted byte-for-byte, the digest
 * that makes a reinstall a no-op, escaping of hostile-looking paths,
 * refusals, and conflict detection against a temp HOME. Nothing here writes
 * to the real HOME or calls launchctl/systemctl — the module cannot.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareInstalled, detectOtherServices, laptopServiceDefinition, type LaptopServiceDefinition } from "./laptop-service.js";
import { definitionDigest, planDaemon } from "./daemon.js";

const identity = { realpath: (path: string) => path };
const base = { home: "/Users/alex", node: "/opt/node/bin/node", dist: "/opt/toolroll/dist", db: "/Users/alex/.config/toolroll/orders.db", port: 4180, pathEnv: "/usr/bin:/bin", fs: identity };

function defined(args: Parameters<typeof laptopServiceDefinition>[0]): LaptopServiceDefinition {
  const result = laptopServiceDefinition(args);
  if ("error" in result) throw new Error(result.error);
  return result;
}

describe("the laptop login item", () => {
  test("macOS: a LaunchAgent pinned to absolute node, entry, canonical database and port", () => {
    const def = defined({ ...base, platform: "darwin" });
    expect(def.label).toBe("com.toolroll.up");
    expect(def.path).toBe("/Users/alex/Library/LaunchAgents/com.toolroll.up.plist");
    expect(def.command).toEqual(["/opt/node/bin/node", "/opt/toolroll/dist/bin.js", "up", "--laptop", "--no-open", "--db", "/Users/alex/.config/toolroll/orders.db", "--port", "4180"]);
    expect(def.digest).toBe(definitionDigest(def.text));
    expect(def.text).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
      <dict>
        <key>Label</key>
        <string>com.toolroll.up</string>

        <key>ProgramArguments</key>
        <array>
          <string>/opt/node/bin/node</string>
          <string>/opt/toolroll/dist/bin.js</string>
          <string>up</string>
          <string>--laptop</string>
          <string>--no-open</string>
          <string>--db</string>
          <string>/Users/alex/.config/toolroll/orders.db</string>
          <string>--port</string>
          <string>4180</string>
        </array>
        <key>WorkingDirectory</key>
        <string>/Users/alex/.config/toolroll</string>
        <key>EnvironmentVariables</key>
        <dict>
          <key>PATH</key>
          <string>/usr/bin:/bin</string>
          <key>TOOLROLL_SERVICE_DIGEST</key>
          <string>b8bc1b22b5bd513af4571e9103f24151bef3775d8ef8e8678ebf3698d43406a2</string>
          <key>STANDING_ORDERS_SERVICE_DIGEST</key>
          <string>b8bc1b22b5bd513af4571e9103f24151bef3775d8ef8e8678ebf3698d43406a2</string>
        </dict>
        <key>RunAtLoad</key>
        <true/>
        <key>KeepAlive</key>
        <true/>
        <key>ThrottleInterval</key>
        <integer>15</integer>
        <key>ExitTimeOut</key>
        <integer>60</integer>
        <key>StandardOutPath</key>
        <string>/Users/alex/.config/toolroll/logs/com.toolroll.up.log</string>
        <key>StandardErrorPath</key>
        <string>/Users/alex/.config/toolroll/logs/com.toolroll.up.log</string>
      </dict>
      </plist>
      "
    `);
  });

  test("Linux: a systemd user unit in the watch unit's shape", () => {
    const def = defined({ ...base, platform: "linux", home: "/home/alex", db: "/home/alex/.config/toolroll/orders.db" });
    expect(def.label).toBe("toolroll-up");
    expect(def.path).toBe("/home/alex/.config/systemd/user/toolroll-up.service");
    expect(def.text).toMatchInlineSnapshot(`
      "[Unit]
      Description=toolroll laptop console

      [Service]
      Environment=PATH=/usr/bin:/bin
      ExecStart=/opt/node/bin/node /opt/toolroll/dist/bin.js up --laptop --no-open --db /home/alex/.config/toolroll/orders.db --port 4180
      WorkingDirectory=/home/alex/.config/toolroll
      Restart=always
      RestartSec=15
      TimeoutStopSec=60

      StandardOutput=append:/home/alex/.config/toolroll/logs/toolroll-up.log
      StandardError=append:/home/alex/.config/toolroll/logs/toolroll-up.log

      [Install]
      WantedBy=default.target
      "
    `);
  });

  test("the digest is stable for the same inputs and moves with any of them", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const one = defined({ ...base, platform });
      expect(defined({ ...base, platform }).digest).toBe(one.digest);
      expect(compareInstalled(one.text, one)).toBe("same");
      expect(compareInstalled(null, one)).toBe("absent");
      for (const change of [{ port: 4181 }, { db: "/Users/alex/other/orders.db" }, { node: "/usr/local/bin/node" }, { dist: "/opt/next/dist" }, { pathEnv: "/usr/bin" }]) {
        const other = defined({ ...base, platform, ...change });
        expect(other.digest).not.toBe(one.digest);
        expect(compareInstalled(other.text, one)).toBe("different");
      }
    }
  });

  // The temp-folder cases need POSIX paths and symlinks; the units never exist on Windows.
  const posixHost = process.platform !== "win32";

  test.runIf(posixHost)("macOS: a changed package at the same path changes the definition (the runtime code is bound)", () => {
    const dir = mkdtempSync(join(tmpdir(), "toolroll-laptop-dist-"));
    try {
      writeFileSync(join(dir, "bin.js"), "// one\n");
      const one = defined({ ...base, platform: "darwin", dist: dir });
      expect(defined({ ...base, platform: "darwin", dist: dir }).digest).toBe(one.digest);
      writeFileSync(join(dir, "bin.js"), "// two\n");
      expect(compareInstalled(one.text, defined({ ...base, platform: "darwin", dist: dir }))).toBe("different");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  const awkward = "/Users/a l&ex/<Tool \"roll\">/it's $HOME %h\\x";

  test("macOS: spaces, &, <, quotes, $ and % survive as one argument each", () => {
    const def = defined({ ...base, platform: "darwin", db: `${awkward}/orders.db`, node: `${awkward}/node`, dist: `${awkward}/dist` });
    expect(def.text).not.toMatch(/<string>[^<]*&(?!amp;|lt;|gt;)/);
    expect(def.text).toContain("<string>/Users/a l&amp;ex/&lt;Tool \"roll\"&gt;/it's $HOME %h\\x/orders.db</string>");
    if (process.platform !== "darwin") return;
    const dir = mkdtempSync(join(tmpdir(), "toolroll-laptop-plist-"));
    try {
      const file = join(dir, "unit.plist");
      writeFileSync(file, def.text);
      expect(spawnSync("plutil", ["-lint", file], { encoding: "utf8" }).status).toBe(0);
      const parsed = spawnSync("plutil", ["-extract", "ProgramArguments", "json", "-o", "-", file], { encoding: "utf8" });
      expect(JSON.parse(parsed.stdout)).toEqual(def.command);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("Linux: quoting keeps paths whole and escapes systemd's % and $ expansion", () => {
    const def = defined({ ...base, platform: "linux", db: `${awkward}/orders.db`, node: "/opt/node/bin/node", dist: "/opt/a b/dist" });
    const exec = /^ExecStart=(.*)$/m.exec(def.text)?.[1];
    expect(exec).toBe(`/opt/node/bin/node "/opt/a b/dist/bin.js" up --laptop --no-open --db "/Users/a l&ex/<Tool \\"roll\\">/it's $$HOME %%h\\\\x/orders.db" --port 4180`);
    expect(def.text).toContain("WorkingDirectory=/Users/a l&ex/<Tool \"roll\">/it's $HOME %%h\\x\n");
    expect(def.text).toContain("StandardOutput=append:/Users/a l&ex/<Tool \"roll\">/it's $HOME %%h\\x/logs/toolroll-up.log\n");
    expect(defined({ ...base, platform: "linux", pathEnv: "/a%b:/c d" }).text).toContain('Environment="PATH=/a%%b:/c d"\n');
  });

  test("refusals: relative, empty, control characters, bad port, unsupported platform, unresolvable folder", () => {
    const refused = (change: Partial<Parameters<typeof laptopServiceDefinition>[0]>) => laptopServiceDefinition({ ...base, platform: "darwin", ...change });
    for (const change of [
      { db: "" }, { db: "orders.db" }, { db: "./state/orders.db" }, { db: "/a/b\n/orders.db" }, { db: "/a/b\0/orders.db" }, { db: "/a/b/" },
      { node: "" }, { node: "node" }, { node: "/opt/node\n" }, { dist: "dist" }, { dist: "/opt/\0dist" }, { home: "~" }, { home: "" },
      { port: 0 }, { port: 65536 }, { port: 41.5 }, { port: Number.NaN },
      { pathEnv: "/usr/bin\nX=1" },
      { platform: "win32" as const }, { platform: "freebsd" as const },
      { fs: { realpath: () => { throw new Error("ENOENT"); } } },
      { fs: { realpath: () => "/resolved\nnext" } },
    ]) expect(refused(change), JSON.stringify(change)).toHaveProperty("error");
  });

  test.runIf(posixHost)("the database is canonical: its folder through realpath, its file name kept", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "toolroll-laptop-db-")));
    try {
      mkdirSync(join(dir, "real"));
      symlinkSync(join(dir, "real"), join(dir, "link"));
      const { fs: _identity, ...real } = base;
      const def = defined({ ...real, platform: "darwin", db: join(dir, "link", "orders.db") });
      expect(def.db).toBe(join(dir, "real", "orders.db"));
      expect(def.command).toContain(join(dir, "real", "orders.db"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe.runIf(process.platform !== "win32")("services laptop mode must not run beside", () => {
  let home: string;
  let state: string;
  let db: string;
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "toolroll-laptop-home-")));
    state = join(home, ".config", "toolroll");
    mkdirSync(state, { recursive: true });
    db = join(state, "orders.db");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const agents = () => { const dir = join(home, "Library", "LaunchAgents"); mkdirSync(dir, { recursive: true }); return dir; };
  const units = () => { const dir = join(home, ".config", "systemd", "user"); mkdirSync(dir, { recursive: true }); return dir; };
  const watch = (platform: "darwin" | "linux", repo: string, configDir: string, label?: string) => {
    const plan = planDaemon({ platform, bin: "/opt/node/bin/node", binArgs: ["/opt/toolroll/dist/bin.js"], runner: "laptop", repo, configDir, watchFlags: ["--containment", "observed"], home, pathEnv: "/usr/bin", ...(label === undefined ? {} : { label }) });
    if ("error" in plan) throw new Error(plan.error);
    mkdirSync(join(plan.unitPath, ".."), { recursive: true });
    writeFileSync(plan.unitPath, plan.unitContent);
    return plan;
  };

  test("an empty HOME has no conflicts", () => {
    expect(detectOtherServices({ platform: "darwin", home, db })).toEqual([]);
    expect(detectOtherServices({ platform: "linux", home, db })).toEqual([]);
  });

  test("macOS: either browser service is a conflict; laptop mode's own unit and unrelated agents are not", () => {
    const dir = agents();
    writeFileSync(join(dir, "com.toolroll.browser.plist"), "<plist/>");
    writeFileSync(join(dir, "com.standing-orders.browser.plist"), "<plist/>");
    writeFileSync(join(dir, "com.toolroll.up.plist"), "<plist/>");
    writeFileSync(join(dir, "com.example.other.plist"), "<plist/>");
    const found = detectOtherServices({ platform: "darwin", home, db });
    expect(Array.isArray(found) && found.map(c => [c.kind, c.label])).toEqual([["browser", "com.toolroll.browser"], ["browser", "com.standing-orders.browser"]]);
  });

  for (const platform of ["darwin", "linux"] as const) {
    test(`${platform}: a watch on this database conflicts, under either label; one on another database does not`, () => {
      platform === "darwin" ? agents() : units();
      const other = join(home, "elsewhere");
      mkdirSync(other);
      const mine = watch(platform, "/work/my repo", state);
      const legacy = watch(platform, "/work/old", state, "com.standing-orders.watch.old");
      watch(platform, "/work/theirs", other);
      const found = detectOtherServices({ platform, home, db });
      expect(Array.isArray(found) && found.map(c => [c.kind, c.label, c.path]).sort()).toEqual([
        ["watch", legacy.label, legacy.unitPath],
        ["watch", mine.label, mine.unitPath],
      ].sort());
    });

    test(`${platform}: the database folder is compared through realpath`, () => {
      platform === "darwin" ? agents() : units();
      symlinkSync(state, join(home, "state-link"));
      watch(platform, "/work/repo", join(home, "state-link"));
      const found = detectOtherServices({ platform, home, db });
      expect(Array.isArray(found) && found.map(c => c.kind)).toEqual(["watch"]);
      const viaLink = detectOtherServices({ platform, home, db: join(home, "state-link", "orders.db") });
      expect(Array.isArray(viaLink) && viaLink.length).toBe(1);
    });
  }

  test("a watch with an explicit --db matches on the database file itself", () => {
    const dir = units();
    const unit = (name: string, dbPath: string) => writeFileSync(join(dir, `${name}.service`), `[Service]\nExecStart=/opt/node /opt/bin.js watch --db "${dbPath}" --token-file /tmp/x/runner-token\n`);
    unit("com.toolroll.watch.same", db);
    unit("com.toolroll.watch.sibling", join(state, "other.db"));
    const found = detectOtherServices({ platform: "linux", home, db });
    expect(Array.isArray(found) && found.map(c => c.label)).toEqual(["com.toolroll.watch.same"]);
  });

  test("fail closed: a watch that cannot be read or names no database is reported", () => {
    const dir = agents();
    mkdirSync(join(dir, "com.toolroll.watch.dir.plist"));
    writeFileSync(join(dir, "com.toolroll.watch.bare.plist"), "<plist><dict><key>ProgramArguments</key><array><string>/x</string></array></dict></plist>");
    const found = detectOtherServices({ platform: "darwin", home, db });
    expect(Array.isArray(found) && found.map(c => c.label)).toEqual(["com.toolroll.watch.bare", "com.toolroll.watch.dir"]);
  });

  test("refusals and unsupported platforms", () => {
    expect(detectOtherServices({ platform: "darwin", home, db: "orders.db" })).toHaveProperty("error");
    expect(detectOtherServices({ platform: "darwin", home: "rel", db })).toHaveProperty("error");
    expect(detectOtherServices({ platform: "win32", home, db })).toEqual([]);
  });
});
