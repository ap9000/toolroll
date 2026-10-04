/**
 * Settings → Tools: a Connect that fails says why at its own button (an
 * alert, focused), not only at the top; and Figma's desktop app has its own
 * Connect with one line of how.
 */
import { expect, test } from "vitest";
import { toolsHtml, type ToolsView } from "./tools-ui.js";

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
  expect(html).toContain(`<button name="service" value="stripe" class="connect-wanted">Connect Stripe</button>${alert}`);
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
  expect(html).toContain('<button name="service" value="figma-desktop" class="connect-tile connect-local" id="connect-figma-desktop" data-state="open"><i aria-hidden="true">F</i><strong>Figma (desktop app)</strong><span>Open the Figma desktop app, turn on the Dev Mode MCP server in Preferences, then Connect.</span></button>');
  expect(html).toContain('<button name="service" value="figma-desktop" class="connect-wanted">Connect Figma (desktop app)</button>');
});
