import { describe, expect, test } from "vitest";
import { browserWorkspaceDocument } from "./browser-shell.js";
import type { BrowserWorkspace } from "./browser-workspace.js";
import { html, htmlString } from "./html.js";

describe("the workspace document", () => {
  test("a `$` pattern in the page's data is kept as text, never expanded into the page", () => {
    const document = html`<html><head><title>Chat</title></head><body><main>Chat</main></body></html>`;
    const title = "Fix $` and $' and $& and $$";
    const workspace = { sensitive: false, firstRun: { steps: [], suggestions: [{ source: "issue", label: title, draft: title }], sandbox: null } } as unknown as BrowserWorkspace;
    const page = htmlString(browserWorkspaceDocument(document, workspace, "n0nce", ""));
    const data = /<script type="application\/json" id="standing-orders-workspace-data" nonce="n0nce">([^]*?)<\/script>/.exec(page)![1]!;
    expect(JSON.parse(data).firstRun.suggestions[0].label).toBe(title);
    expect(page.match(/<\/script>/g)).toHaveLength(4);
  });
});
