/**
 * Messaging settings: which connected service receives alerts, and the
 * console URL chat links open.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWebhookTargets, activeWebhookTargets, webhookPass, LEGACY_WEBHOOK_WARNING, saveConsoleUrl, loadConsoleUrl, effectivePrimary, savePrimary, phoneOrigin, CONSOLE_URL_ENV } from "./webhooks.js";
import { saveSlackCredentials, slackCredentialFile } from "./slack-api.js";

describe("the primary — one service pages, chosen or sensibly implied", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-primary-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("implicit until chosen; explicit wins only while its service is configured", () => {
    // Nothing configured: nobody pages, nothing implicit.
    expect(effectivePrimary({}, dir, false)).toMatchObject({ channel: null, implicit: false });

    // Telegram alone: it pages, no ambiguity.
    expect(effectivePrimary({}, dir, true)).toMatchObject({ channel: "telegram", implicit: false });

    // Telegram + Slack, nothing chosen: telegram pages BY DEFAULT and the
    // status is flagged implicit — the "pick one" moment.
    saveSlackCredentials(dir, { team: "T0", app: "A0", bot: "B0", installation: "I0", workspace: "w", appToken: "xapp-fixture", botToken: "xoxb-fixture" });
    expect(effectivePrimary({}, dir, true)).toMatchObject({ channel: "telegram", implicit: true });

    // The choice sticks.
    savePrimary(dir, "slack");
    expect(effectivePrimary({}, dir, true)).toMatchObject({ channel: "slack", implicit: false });

    // A primary pointing at a service that is no longer configured falls
    // through instead of silencing every page.
    rmSync(slackCredentialFile(dir));
    expect(effectivePrimary({}, dir, true)).toMatchObject({ channel: "telegram" });
  });

  test("legacy notification-only settings remain selectable for this release", () => {
    writeFileSync(join(dir, "slack-webhook"), "https://hooks.slack.com/services/T/B/x\n", { mode: 0o600 });
    expect(effectivePrimary({ TOOLROLL_DISCORD_WEBHOOK: "https://discord.com/api/webhooks/1/y" }, dir, false)).toEqual({ channel: "slack", implicit: true, configured: ["slack", "discord"], legacyWarning: LEGACY_WEBHOOK_WARNING });
  });

  test("the console URL saves normalized", () => {
    expect(saveConsoleUrl(dir, "http://server.tailae758.ts.net:4180/")).toMatchObject({ ok: true });
    expect(loadConsoleUrl({}, dir)).toBe("http://server.tailae758.ts.net:4180");
  });
});

describe("the console URL is parsed, not pattern-matched (attended A5)", () => {
  test("credentials, queries, fragments, and odd schemes refuse; a clean base normalizes", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "console-url-"));
    try {
      expect(saveConsoleUrl(dir, "http://user:secret@host:4180")).toMatchObject({ ok: false });
      expect(saveConsoleUrl(dir, "http://host:4180/?q=1")).toMatchObject({ ok: false });
      expect(saveConsoleUrl(dir, "http://host:4180/#frag")).toMatchObject({ ok: false });
      expect(saveConsoleUrl(dir, "ftp://host:4180")).toMatchObject({ ok: false });
      expect(saveConsoleUrl(dir, "not a url")).toMatchObject({ ok: false });
      expect(saveConsoleUrl(dir, "http://host:4180/base/")).toMatchObject({ ok: true });
      expect(loadConsoleUrl({}, dir)).toBe("http://host:4180/base");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the phone origin: the same console-url setting, held to an https origin and re-read every time", () => {
  test("only a clean https origin qualifies; http, credentials, path, query, fragment, loopback and a removed setting give no link; a co-hosted --public-url must match exactly", () => {
    const dir = mkdtempSync(join(tmpdir(), "phone-origin-"));
    try {
      expect(phoneOrigin({}, dir)).toBeNull();
      expect(saveConsoleUrl(dir, "https://console.example:8443/")).toMatchObject({ ok: true });
      expect(phoneOrigin({}, dir)).toBe("https://console.example:8443");
      // The generic mirror setting keeps accepting http and a path prefix (unrelated consumers rely on it); the phone refuses both.
      expect(saveConsoleUrl(dir, "http://console.example:8443")).toMatchObject({ ok: true });
      expect(loadConsoleUrl({}, dir)).toBe("http://console.example:8443");
      expect(phoneOrigin({}, dir)).toBeNull();
      expect(saveConsoleUrl(dir, "https://console.example/base/")).toMatchObject({ ok: true });
      expect(loadConsoleUrl({}, dir)).toBe("https://console.example/base");
      expect(phoneOrigin({}, dir)).toBeNull();
      // The environment wins over the file and is parsed to the same rule — nothing the setter refused can arrive through it either.
      // Loopback under every spelling the parser canonicalises: dotted, IPv6, and an IPv4 mapped or embedded in IPv6.
      for (const bad of ["https://user:pw@console.example", "https://console.example/?q=1", "https://console.example/#frag", "https://localhost:4180", "https://127.0.0.1:4180", "https://127.1.2.3", "https://0.0.0.0", "https://[::1]:4180", "https://[::]:4180", "https://[::ffff:127.0.0.1]", "https://[::ffff:7f00:1]", "https://[0:0:0:0:0:ffff:127.0.0.1]:4180", "https://[::ffff:0.0.0.0]", "https://[::127.0.0.1]", "https://app.localhost", "ftp://console.example", "console.example", "not a url", "   "]) {
        expect(phoneOrigin({ [CONSOLE_URL_ENV]: bad }, dir), bad).toBeNull();
      }
      expect(phoneOrigin({ [CONSOLE_URL_ENV]: "https://Console.Example:443/" }, dir)).toBe("https://console.example");
      for (const local of ["https://localhost.", "https://app.localhost."]) {
        expect(phoneOrigin({ [CONSOLE_URL_ENV]: local }, dir), local).toBeNull();
      }
      expect(phoneOrigin({ [CONSOLE_URL_ENV]: "https://server.tailae758.ts.net" }, dir)).toBe("https://server.tailae758.ts.net");
      // A public address embedded the same way is not loopback, and neither is a routable literal.
      expect(phoneOrigin({ [CONSOLE_URL_ENV]: "https://[::ffff:203.0.113.9]" }, dir)).toBe("https://[::ffff:cb00:7109]");
      expect(phoneOrigin({ [CONSOLE_URL_ENV]: "https://[2001:db8::10]:8443" }, dir)).toBe("https://[2001:db8::10]:8443");
      // Co-hosted with a stated public origin: equal or nothing.
      expect(saveConsoleUrl(dir, "https://console.example")).toMatchObject({ ok: true });
      expect(phoneOrigin({}, dir, { serverOrigin: "https://console.example" })).toBe("https://console.example");
      expect(phoneOrigin({}, dir, { serverOrigin: "https://console.example/" })).toBe("https://console.example");
      expect(phoneOrigin({}, dir, { serverOrigin: "https://elsewhere.example" })).toBeNull();
      expect(phoneOrigin({}, dir, { serverOrigin: "https://console.example:8443" })).toBeNull();
      expect(phoneOrigin({}, dir, { serverOrigin: "not a url" })).toBeNull();
      expect(phoneOrigin({}, dir, { serverOrigin: null })).toBe("https://console.example");
      // Removed: the very next read is null — nothing was cached.
      rmSync(join(dir, "console-url"));
      expect(phoneOrigin({}, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


test("legacy discovery, destination receipts, retry and adapter suppression", async () => {
  const { openStore } = await import("./store.js");
  const dir = mkdtempSync(join(tmpdir(), "standing-orders-legacy-webhooks-")), store = openStore(":memory:");
  const now = new Date("2026-10-08T00:00:00Z");
  try {
    writeFileSync(join(dir, "slack-webhook"), "https://hooks.slack.com/services/file-secret");
    writeFileSync(join(dir, "discord-webhook"), "https://discord.com/api/webhooks/file-secret");
    const env = { TOOLROLL_SLACK_WEBHOOK: "https://hooks.slack.com/services/env-secret" };
    const targets = loadWebhookTargets(env, dir);
    expect(targets.map(t => t.url)).toEqual([env.TOOLROLL_SLACK_WEBHOOK, "https://discord.com/api/webhooks/file-secret"]);
    expect(activeWebhookTargets(env, dir, "telegram")).toEqual([]);
    expect(activeWebhookTargets(env, dir, "slack")).toEqual([targets[0]]);
    saveSlackCredentials(dir, { team: "T0", app: "A0", bot: "B0", installation: "I0", workspace: "w", appToken: "xapp-fixture", botToken: "xoxb-fixture" });
    expect(activeWebhookTargets(env, dir, "slack")).toEqual([]);
    store.enqueueNotification({ source: { installation: true }, dedupeKey: "legacy", kind: "test", subject: "Plan ready", body: "Review the saved plan." }, now);
    store.enqueueNotification({ source: { installation: true }, dedupeKey: "resolved", kind: "test", subject: "Resolved", body: "Done" }, now);
    const [first, resolved] = store.listNotifications().map(row => row.id);
    store.resolveEpisode("resolved", now);
    let failed = true;
    const requests: string[] = [];
    const fetcher = (async (url: string | URL | Request) => { requests.push(String(url)); if (String(url).includes("discord") && failed) throw Error(String(url)); return new Response("ok"); }) as typeof fetch;
    const pass = () => webhookPass(store, { targets, consoleUrl: null, fetcher, clock: () => now });
    expect(await pass()).toEqual({ sent: 1, problems: [`notification ${first}: discord delivery failed`] });
    failed = false;
    expect(await pass()).toEqual({ sent: 1, problems: [] });
    expect(await pass()).toEqual({ sent: 0, problems: [] });
    expect(requests).toHaveLength(3);
    const rows = store.handle.prepare("SELECT notification, destination, attempts, delivered_at, last_error FROM notification_delivery ORDER BY destination").all();
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row["notification"] === first && row["notification"] !== resolved && row["delivered_at"] !== null)).toBe(true);
    expect(rows.map(row => row["attempts"])).toEqual([2, 1]);
    expect(JSON.stringify(rows)).not.toContain("secret");
    expect(store.handle.prepare("SELECT name FROM pragma_table_info('notification') WHERE name = 'delivered_at'").all()).toEqual([]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
