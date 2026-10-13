/**
 * Settings → Tools: a Connect that fails says why at its own button (an
 * alert, focused), not only at the top; and Figma's desktop app has its own
 * Connect with one line of how.
 */
import { expect, test } from "vitest";
import { toolsHtml as renderTools, type ToolsView } from "./tools-ui.js";
import { htmlString } from "./html.js";
import { withFormToken } from "./server/request-context.js";

// The page as a browser session with this token would get it (its forms carry the token).
const toolsHtml = (...args: Parameters<typeof renderTools>) => htmlString(withFormToken(args[1], () => renderTools(...args)));

const view = (wanted: string | null): ToolsView => ({
  repo: "/work/shop", project: "shop", kit: null, wanted, tools: [], catalog: [], found: [],
  connections: [
    { id: "stripe", label: "Stripe", about: "Payments, customers, refunds and invoices.", state: "open" },
    { id: "figma-desktop", label: "Figma (desktop app)", about: "Open the Figma desktop app, turn on the Dev Mode MCP server in Preferences, then Connect.", state: "open", local: true },
  ],
});

test("a failed Connect says why as a focused alert right under its button, and not again at the top", () => {
  const html = toolsHtml(view("stripe"), "csrf", true, { problem: "Stripe doesn't let other apps sign in this way yet." });
  const alert = '<p class="problem connect-problem" id="connect-problem" role="alert" tabindex="-1" autofocus>Stripe doesn&#39;t let other apps sign in this way yet.</p>';
  expect(html).toContain(`<button name="service" value="stripe" class="connect-wanted">Connect Stripe to shop</button>${alert}`);
  expect(html.match(/role="alert"/g)).toHaveLength(1);
  expect(html.indexOf(alert)).toBeGreaterThan(html.indexOf('id="connect-heading"'));
});

test("a problem that isn't one service's Connect stays at the top", () => {
  const html = toolsHtml(view(null), "csrf", true, { problem: "Choose a service to connect." });
  expect(html).toMatch(/^<section class="tools"><p class="problem" role="alert">Choose a service to connect\.<\/p>/);
  expect(html).not.toContain("connect-problem");
});

test("Figma's desktop app has its own Connect, with its one line of how", () => {
  const html = toolsHtml(view("figma-desktop"), "csrf", true);
  // Figma's desktop app wears Figma's own mark, in the same frame as every tile.
  expect(html).toContain('<button name="service" value="figma-desktop" class="connect-tile connect-local" id="connect-figma-desktop" data-state="open" aria-label="Connect Figma (desktop app) to shop"><span class="brand-mark" data-connected="false" aria-hidden="true"><svg');
  expect(html).toContain('</span><strong>Figma (desktop app)</strong><span>Open the Figma desktop app, turn on the Dev Mode MCP server in Preferences, then Connect.</span></button>');
  expect(html).toContain('<button name="service" value="figma-desktop" class="connect-wanted">Connect Figma (desktop app) to shop</button>');
});

test("PostHog connected with write access stays Connected, says once why research can't use it, and offers Reconnect read-only", () => {
  const posthog = { id: 1, repo: "/work/shop", name: "posthog", digest: "d", source: "PostHog, connected by signing in", createdAt: "2026-10-05T00:00:00.000Z", createdBy: "alex",
    lastTest: { at: "2026-10-05T00:00:00.000Z", ok: true, tools: ["exec"], problem: null },
    spec: { name: "posthog", transport: "http" as const, command: null, args: [], url: "https://mcp.posthog.com/mcp", bearer: "OAUTH_ACCESS_TOKEN", headerSecrets: {}, secrets: [{ name: "OAUTH_ACCESS_TOKEN", optional: false }], about: "PostHog: Product analytics, funnels and events. Connected by signing in." } };
  const said = "PostHog is connected with write access, so research runs can&#39;t use it.";
  const html = toolsHtml({ ...view(null), tools: [{ tool: posthog, secretsSet: ["OAUTH_ACCESS_TOKEN"] }],
    connections: [{ id: "posthog", label: "PostHog", about: "Product analytics, funnels and events.", state: "connected", research: "PostHog is connected with write access, so research runs can't use it." }] }, "csrf", true);
  expect(html).toContain(`<span class="tool-state" data-ready="true">Working · 1 tool</span>`);
  expect(html.split(said)).toHaveLength(2);
  expect(html).toContain(`<p class="tool-note" role="status">${said}</p><details><summary>Reconnect read-only</summary><form method="post" action="/settings/tools/connect"><input type="hidden" name="csrf" value="csrf"><input type="hidden" name="repo" value="/work/shop"><input type="hidden" name="shown" value="/work/shop"><input type="hidden" name="service" value="posthog"><input type="hidden" name="access" value="read"><label>Your Toolroll password`);
  expect(html.match(/>Reconnect read-only</g)).toHaveLength(2);
  expect(html).toContain('<strong>PostHog</strong><span>Connected</span></button>');
  // Someone who can't manage tools sees why, without a control they can't use.
  const viewer = toolsHtml({ ...view(null), tools: [{ tool: posthog, secretsSet: ["OAUTH_ACCESS_TOKEN"] }], connections: [{ id: "posthog", label: "PostHog", about: "", state: "connected", research: "PostHog is connected with write access, so research runs can't use it." }] }, "", false);
  expect(viewer).toContain(said);
  expect(viewer).not.toContain("Reconnect read-only");
});

test("each tool says in one line how its runs get credentials, explains it under Details, and the page says once when secrets are file-protected only", () => {
  const tool = (name: string, spec: Partial<ToolsView["tools"][number]["tool"]["spec"]>) => ({ id: 1, repo: "/work/shop", name, digest: "d", source: "custom", createdAt: "2026-10-05T00:00:00.000Z", createdBy: "alex", lastTest: null,
    spec: { name, transport: "http" as const, command: null, args: [], url: `https://mcp.${name}.example/mcp`, bearer: null, headerSecrets: {}, secrets: [], about: `${name} tools.`, ...spec } });
  const oauth = { bearer: "OAUTH_ACCESS_TOKEN", secrets: ["OAUTH_ACCESS_TOKEN", "OAUTH_REFRESH_TOKEN", "OAUTH_CLIENT_ID", "OAUTH_TOKEN_URL"].map(name => ({ name, optional: name !== "OAUTH_ACCESS_TOKEN" })) };
  const tools = [
    { tool: tool("linear", oauth), secretsSet: ["OAUTH_ACCESS_TOKEN", "OAUTH_REFRESH_TOKEN", "OAUTH_CLIENT_ID", "OAUTH_TOKEN_URL"] },
    { tool: tool("notion", oauth), secretsSet: ["OAUTH_ACCESS_TOKEN"] },
    { tool: tool("github", { bearer: "GITHUB_TOKEN", secrets: [{ name: "GITHUB_TOKEN", optional: false }] }), secretsSet: ["GITHUB_TOKEN"] },
    { tool: tool("playwright", {}), secretsSet: [] },
    { tool: tool("sentry", { secrets: [{ name: "SENTRY_ACCESS_TOKEN", optional: false }] }), secretsSet: [] },
  ];
  const files = { words: "Secrets are protected by owner-only files on this computer.", filesOnly: true };
  const html = toolsHtml({ ...view(null), tools, storage: files }, "csrf", true);
  const line = (name: string) => /<p class="tool-credential" data-credential="([a-z-]+)">([^<]+)<\/p>/.exec(html.slice(html.indexOf(`id="tool-${name}"`)).split("</article>")[0]!)?.slice(1) ?? null;
  expect(line("linear")).toEqual(["run-token", "Short-lived token per run"]);
  expect(line("notion")).toEqual(["held-key", "Key held by Toolroll"]);
  expect(line("github")).toEqual(["held-key", "Key held by Toolroll"]);
  expect(line("playwright")).toEqual(["no-key", "No key needed"]);
  // A key not set yet: the state says what's missing, and no mode is claimed.
  expect(line("sentry")).toBeNull();
  expect(html).toContain('<span class="tool-state" data-ready="false">Needs SENTRY_ACCESS_TOKEN</span>');
  expect(html).toContain("<details><summary>Details</summary><div class=\"tool-facts\"><p>Each run gets its own access token when it starts, revoked or left to expire when it ends. The refresh token stays with Toolroll.</p>");
  // A service connected by signing in renews by signing in again: none of its tokens is offered to paste.
  expect(html.slice(html.indexOf('id="tool-linear"')).split("</article>")[0]).not.toMatch(/<summary>(Set|Replace) OAUTH_/);
  expect(html).toContain("<summary>Replace GITHUB_TOKEN</summary>");
  expect(html.split(files.words)).toHaveLength(2);
  expect(html).toContain(`<p class="tool-storage" role="note">${files.words}</p>`);
  // With a keychain, the note is gone and How tools work says where secrets are kept.
  const keychain = toolsHtml({ ...view(null), tools, storage: { words: "Secrets are kept in the macOS Keychain.", filesOnly: false } }, "csrf", true);
  expect(keychain).not.toContain("tool-storage");
  expect(keychain).toContain("<li>Secrets are kept in the macOS Keychain, are never shown again, and go only to the tool that needs them.</li>");
});
