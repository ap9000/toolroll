/**
 * Attack: choose Antigravity to widen a project's network. Antigravity talks to a helper of its own on this machine's
 * loopback, and the macOS sandbox can't admit one local port without admitting all of them, so it used to force
 * `loopback: any` onto every scope and launch it ran in, whatever the project chose. Guard: the project's choice is
 * sealed as it is (egress.ts resolveNetwork, providerOnlyNetwork); under a project that keeps local services out, the
 * launch is refused in plain words (localServicesRefusal), and the fence built from that policy admits no other local
 * port.
 */
import { createServer as createHttpServer, type Server } from "node:http";
import { realpathSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { NO_GRANTS, type NetworkFence } from "../../src/agent-fence.js";
import { localServicesRefusal, PROJECT_NETWORK_DEFAULT, providerOnlyNetwork, resolveNetwork, startEgressProxy, type EgressProxy } from "../../src/egress.js";
import { lines, needs, osFence, underSandboxAsync, useScratch } from "./harness.js";

const servers: Server[] = [];
const proxies: EgressProxy[] = [];
afterEach(async () => {
  for (const one of servers.splice(0)) one.close();
  for (const one of proxies.splice(0)) await one.close();
});

async function localService(): Promise<number> {
  const server = createHttpServer((_, response) => response.end("local-service"));
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
  return (server.address() as { port: number }).port;
}

describe("attack: Antigravity widening a proxy-only project's network", () => {
  const scratch = useScratch("agyloop");

  test("the project's proxy-only choice is sealed as it is, for every way a launch gets its network", () => {
    const proxyOnly = { mode: "allowlist" as const, hosts: ["api.example.com"], loopback: "proxy-only" as const };
    expect(resolveNetwork("antigravity", proxyOnly, ["npm"]).loopback).toBe("proxy-only");
    expect(resolveNetwork("antigravity", PROJECT_NETWORK_DEFAULT, []).loopback).toBe("proxy-only");
    expect(providerOnlyNetwork("antigravity").loopback).toBe("proxy-only");
    // An open project stays as the project chose it, too.
    expect(resolveNetwork("antigravity", { mode: "open", hosts: [], loopback: "proxy-only" }, []).loopback).toBe("proxy-only");
  });

  test("on a Mac, an Antigravity launch under proxy-only is refused in plain words; one the project allows starts", () => {
    const refused = localServicesRefusal("antigravity", { mode: "allowlist", loopback: "proxy-only" }, "darwin");
    expect(refused).toContain("allow local services in the project's network settings");
    expect(localServicesRefusal("antigravity", undefined, "darwin")).not.toBeNull();
    expect(localServicesRefusal("antigravity", { mode: "allowlist", loopback: "any" }, "darwin")).toBeNull();
    expect(localServicesRefusal("antigravity", { mode: "open" }, "darwin")).toBeNull();
    // Linux gives every build a loopback of its own; other agents never need local services.
    expect(localServicesRefusal("antigravity", { mode: "allowlist", loopback: "proxy-only" }, "linux")).toBeNull();
    expect(localServicesRefusal("claude", { mode: "allowlist", loopback: "proxy-only" }, "darwin")).toBeNull();
  });

  test("the fence built from an Antigravity scope under a proxy-only project reaches no other local port", async ctx => {
    ctx.skip(process.platform !== "darwin", "macOS loopback checks skipped: not macOS");
    needs(ctx, osFence());
    const dir = scratch();
    const local = await localService();
    const policy = resolveNetwork("antigravity", PROJECT_NETWORK_DEFAULT, []);
    const proxy = await startEgressProxy({ hosts: policy.hosts });
    proxies.push(proxy);
    const network: NetworkFence = { mode: "allowlist", proxyPort: proxy.port, brokerPorts: [], loopback: policy.loopback, socketRoots: [realpathSync(dir)], token: proxy.secret };
    const result = await underSandboxAsync([
      `curl -s -m 5 --noproxy '*' http://127.0.0.1:${local}/ || echo other-loopback-refused`,
      `python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1', 0)); s.listen(1); print('bound')" 2>/dev/null || echo bind-refused`,
    ].join("\n"), [], { ...NO_GRANTS, network }, { cwd: dir, env: { ...process.env, NODE_OPTIONS: undefined } as NodeJS.ProcessEnv });
    expect(lines(result), result.stderr).toEqual(["other-loopback-refused", "bind-refused"]);
  });
});
