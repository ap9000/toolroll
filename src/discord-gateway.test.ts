/** The Discord Gateway client against a local fake gateway (a ws server on 127.0.0.1); no Discord account. */
import { afterEach, describe, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { DISCORD_INTENTS, DiscordGateway, DiscordGatewayError, trustedGatewayUrl, type DiscordGatewayOptions } from "./discord-gateway.js";

const TOKEN = ["synthetic", "gateway", "fixture", "token", "never-sent"].join("-");
type Sent = { op: number; d: any };

/** A scripted gateway: every connection, and every payload the client sent on it. */
class FakeGateway {
  readonly server: WebSocketServer;
  readonly connections: Array<{ socket: WebSocket; sent: Sent[]; url: string }> = [];
  onConnect: (socket: WebSocket, index: number) => void = (socket) => this.hello(socket);
  onPayload: (socket: WebSocket, payload: Sent, index: number) => void = () => {};
  constructor() {
    this.server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    this.server.on("connection", (socket, request) => {
      const index = this.connections.push({ socket, sent: [], url: request.url ?? "" }) - 1;
      socket.on("message", (data) => {
        const payload = JSON.parse(String(data)) as Sent;
        this.connections[index]!.sent.push(payload);
        this.onPayload(socket, payload, index);
      });
      this.onConnect(socket, index);
    });
  }
  async ready(): Promise<string> {
    if (!this.server.address()) await new Promise((r) => this.server.once("listening", r));
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
  }
  hello(socket: WebSocket, interval = 60_000) {
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: interval }, s: null, t: null }));
  }
  dispatch(socket: WebSocket, t: string, s: number, d: unknown) {
    socket.send(JSON.stringify({ op: 0, t, s, d }));
  }
  ready_(socket: WebSocket, resume: string, s = 1) {
    this.dispatch(socket, "READY", s, { session_id: "session-1", resume_gateway_url: resume, application: { id: "1" }, user: { id: "1", bot: true } });
  }
  close() {
    for (const c of this.connections) c.socket.terminate();
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

const until = async (check: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let fakes: FakeGateway[] = [], clients: DiscordGateway[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.destroy()));
  await Promise.all(fakes.map((f) => f.close()));
  fakes = [];
  clients = [];
});
async function setup(options: DiscordGatewayOptions = {}) {
  const fake = new FakeGateway();
  fakes.push(fake);
  const url = await fake.ready();
  // Tests trust only this fake as a resume address; production trusts only *.discord.gg (trustedGatewayUrl).
  const client = new DiscordGateway({ url, trust: (raw) => (raw === url ? url : null), backoff: () => 10, identifyGapMs: 0, invalidSessionDelay: () => 10, ...options });
  clients.push(client);
  const events: string[] = [];
  const raws: Array<{ t: string; s: number; d: any }> = [];
  for (const name of ["shardReady", "shardResume", "shardReconnecting", "shardDisconnect"]) client.on(name, () => events.push(name));
  client.on("raw", (packet: { t: string; s: number; d: any }) => {
    events.push(`raw:${packet.t}`);
    raws.push(packet);
  });
  return { fake, url, client, events, raws };
}

describe("Discord gateway client", () => {
  test("identifies with the token and intents, resolves at READY, and passes dispatches on as raw packets", async () => {
    const { fake, url, client, events, raws } = await setup();
    fake.onPayload = (socket, payload) => {
      if (payload.op !== 2) return;
      fake.ready_(socket, url);
      fake.dispatch(socket, "MESSAGE_CREATE", 2, { id: "5", content: "hi" });
      fake.dispatch(socket, "INTERACTION_CREATE", 3, { id: "6", type: 3 });
    };
    await expect(client.login(TOKEN)).resolves.toBe(TOKEN);
    await until(() => raws.length === 3);
    expect(fake.connections[0]!.url).toBe("/?v=10&encoding=json");
    const identify = fake.connections[0]!.sent.find((p) => p.op === 2)!;
    expect(identify.d).toEqual({ token: TOKEN, intents: DISCORD_INTENTS, properties: { os: process.platform, browser: "toolroll", device: "toolroll" } });
    // Direct messages, guild messages, message content: the three intents the follower needs.
    expect(DISCORD_INTENTS).toBe(4096 + 512 + 32768);
    // READY reaches the raw listener (which validates the identity) before shardReady marks the connection online.
    expect(events.slice(0, 2)).toEqual(["raw:READY", "shardReady"]);
    expect(raws.map((r) => [r.t, r.s])).toEqual([["READY", 1], ["MESSAGE_CREATE", 2], ["INTERACTION_CREATE", 3]]);
    expect(raws[1]!.d).toEqual({ id: "5", content: "hi" });
  });

  test("heartbeats with the last sequence, answers a heartbeat request at once, and resumes a zombie connection", async () => {
    const { fake, url, client, events } = await setup();
    let ack = true;
    fake.onConnect = (socket) => fake.hello(socket, 300);
    fake.onPayload = (socket, payload, index) => {
      if (payload.op === 2) fake.ready_(socket, url, 7);
      if (payload.op === 1 && ack) socket.send(JSON.stringify({ op: 11, d: null, s: null, t: null }));
      if (payload.op === 6 && index === 1) fake.dispatch(socket, "RESUMED", 8, {});
    };
    await client.login(TOKEN);
    const first = fake.connections[0]!;
    await until(() => first.sent.filter((p) => p.op === 1).length >= 2);
    expect(first.sent.filter((p) => p.op === 1).every((p) => p.d === 7)).toBe(true);
    const before = first.sent.length;
    first.socket.send(JSON.stringify({ op: 1, d: null, s: null, t: null }));
    await until(() => first.sent.length > before);
    expect(first.sent.at(-1)).toEqual({ op: 1, d: 7 });
    // Discord stops acknowledging: the next beat finds no ACK, closes and resumes the same session.
    ack = false;
    await until(() => fake.connections.length === 2 && fake.connections[1]!.sent.some((p) => p.op === 6));
    expect(fake.connections[1]!.sent.find((p) => p.op === 6)!.d).toEqual({ token: TOKEN, session_id: "session-1", seq: 7 });
    expect(fake.connections[1]!.sent.some((p) => p.op === 2)).toBe(false);
    await until(() => events.includes("shardResume"));
    expect(events).toContain("shardReconnecting");
  });

  test("a reconnect request or a dropped connection resumes; a lost session identifies again", async () => {
    const { fake, url, client, events } = await setup();
    fake.onPayload = (socket, payload, index) => {
      if (payload.op === 2) fake.ready_(socket, url, 4);
      if (payload.op === 6) fake.dispatch(socket, "RESUMED", 5, {});
      void index;
    };
    await client.login(TOKEN);
    fake.connections[0]!.socket.send(JSON.stringify({ op: 7, d: null, s: null, t: null }));
    await until(() => fake.connections.length === 2 && fake.connections[1]!.sent.some((p) => p.op === 6));
    await until(() => events.includes("shardResume"));
    fake.connections[1]!.socket.terminate();
    await until(() => fake.connections.length === 3 && fake.connections[2]!.sent.some((p) => p.op === 6));
    expect(fake.connections[2]!.sent.find((p) => p.op === 6)!.d.seq).toBe(5);
    // 4009 (session timed out) ends the session: the next connection identifies, it does not resume.
    fake.connections[2]!.socket.close(4009);
    await until(() => fake.connections.length === 4 && fake.connections[3]!.sent.length > 0);
    expect(fake.connections[3]!.sent[0]!.op).toBe(2);
  });

  test("an invalid session that can resume resumes; one that cannot identifies fresh", async () => {
    const { fake, url, client } = await setup();
    fake.onPayload = (socket, payload) => {
      if (payload.op === 2) fake.ready_(socket, url, 3);
    };
    await client.login(TOKEN);
    fake.connections[0]!.socket.send(JSON.stringify({ op: 9, d: true, s: null, t: null }));
    await until(() => fake.connections.length === 2 && fake.connections[1]!.sent.length > 0);
    expect(fake.connections[1]!.sent[0]).toEqual({ op: 6, d: { token: TOKEN, session_id: "session-1", seq: 3 } });
    fake.connections[1]!.socket.send(JSON.stringify({ op: 9, d: false, s: null, t: null }));
    await until(() => fake.connections.length === 3 && fake.connections[2]!.sent.length > 0);
    expect(fake.connections[2]!.sent[0]!.op).toBe(2);
  });

  test("identifies at most once per gap", async () => {
    const { fake, client } = await setup({ identifyGapMs: 400 });
    const at: number[] = [];
    fake.onPayload = (socket, payload) => {
      if (payload.op !== 2) return;
      at.push(Date.now());
      if (at.length < 3) socket.send(JSON.stringify({ op: 9, d: false, s: null, t: null }));
      else fake.ready_(socket, "wss://untrusted.example/");
    };
    await wait(450); // clear any identify an earlier test in this file sent
    await client.login(TOKEN);
    expect(at).toHaveLength(3);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(380);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(380);
  });

  test("a rejected token (4004) rejects the login and never reconnects", async () => {
    const { fake, client, events } = await setup();
    fake.onPayload = (socket, payload) => {
      if (payload.op === 2) socket.close(4004);
    };
    const error = await client.login(TOKEN).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscordGatewayError);
    expect(error).toMatchObject({ code: 4004, fatal: true });
    expect(String((error as Error).message)).toMatch(/rejected the bot token/);
    expect(String((error as Error).message)).not.toContain(TOKEN);
    await wait(300); // backoff is 10 ms here: a reconnect loop would have made many connections by now
    expect(fake.connections).toHaveLength(1);
    expect(events).not.toContain("shardReconnecting");
    await expect(client.login(TOKEN)).rejects.toBeInstanceOf(DiscordGatewayError);
  });

  test("a refusal after READY disconnects for good and reports an error", async () => {
    const { fake, url, client, events } = await setup();
    fake.onPayload = (socket, payload) => {
      if (payload.op === 2) fake.ready_(socket, url);
    };
    const errors: unknown[] = [];
    client.on("error", (e) => errors.push(e));
    await client.login(TOKEN);
    fake.connections[0]!.socket.close(4014);
    await until(() => errors.length === 1);
    expect(errors[0]).toMatchObject({ code: 4014, fatal: true });
    expect(events).toContain("shardDisconnect");
    await wait(200);
    expect(fake.connections).toHaveLength(1);
  });

  test("the token is never sent to a resume address that is not Discord's gateway", async () => {
    const elsewhere = new FakeGateway();
    fakes.push(elsewhere);
    const decoy = await elsewhere.ready();
    // Production trust: the decoy (a 127.0.0.1 address) is not under discord.gg, so the client identifies again at the
    // first address instead of resuming at the one READY supplied.
    const { fake, client } = await setup({ trust: trustedGatewayUrl });
    fake.onPayload = (socket, payload) => {
      if (payload.op === 2) fake.ready_(socket, decoy, 9);
    };
    await client.login(TOKEN);
    fake.connections[0]!.socket.send(JSON.stringify({ op: 7, d: null, s: null, t: null }));
    await until(() => fake.connections.length === 2 && fake.connections[1]!.sent.length > 0);
    expect(fake.connections[1]!.sent[0]!.op).toBe(2);
    expect(elsewhere.connections).toHaveLength(0);
  });

  test("destroy rejects a pending login, closes the socket and stops reconnecting", async () => {
    const { fake, client } = await setup();
    fake.onConnect = () => {}; // no HELLO: the login stays pending
    const login = client.login(TOKEN).catch((e: unknown) => e);
    await until(() => fake.connections.length === 1);
    await client.destroy();
    expect(await login).toBeInstanceOf(DiscordGatewayError);
    await wait(100);
    expect(fake.connections).toHaveLength(1);
    expect(fake.connections[0]!.socket.readyState).toBeGreaterThanOrEqual(2);
  });

  test("a malformed token never opens a connection", async () => {
    const { fake, client } = await setup();
    await expect(client.login("bad token\nInjected: header")).rejects.toBeInstanceOf(DiscordGatewayError);
    await wait(50);
    expect(fake.connections).toHaveLength(0);
  });
});

describe("trusted gateway addresses", () => {
  test("only wss:// hosts under discord.gg, rebuilt from the host alone", () => {
    expect(trustedGatewayUrl("wss://gateway-us-east1-b.discord.gg")).toBe("wss://gateway-us-east1-b.discord.gg/");
    expect(trustedGatewayUrl("wss://gateway.discord.gg/?v=9&x=y#z")).toBe("wss://gateway.discord.gg/");
    expect(trustedGatewayUrl("wss://gateway.discord.gg:443/")).toBe("wss://gateway.discord.gg/");
    for (const bad of [
      "ws://gateway.discord.gg",
      "https://gateway.discord.gg",
      "wss://evil.example",
      "wss://discord.gg.evil.example",
      "wss://evildiscord.gg",
      "wss://evil.example/.discord.gg",
      "wss://evil.example#.discord.gg",
      "wss://user:pass@gateway.discord.gg",
      "wss://gateway.discord.gg:8443",
      "wss://127.0.0.1",
      "",
      null,
      42,
    ])
      expect(trustedGatewayUrl(bad), String(bad)).toBeNull();
  });
});
