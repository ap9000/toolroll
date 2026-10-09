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
