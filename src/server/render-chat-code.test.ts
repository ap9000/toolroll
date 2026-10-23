import { describe, expect, test } from "vitest";
import { htmlString } from "../html.js";
import { renderChatText, steerCommentHtml } from "./render-chat.js";
import { reviewDiffHtml } from "./render-results.js";

const render = (text: string) => htmlString(renderChatText(text));

describe("a lead reply's fenced code", () => {
  test("is a code block, exactly as written, with its language named", () => {
    const out = render("Here is the fix:\n\n```ts\nconst a = 1;\n- not a bullet\n  indented\n```\n\nThat's all.");
    expect(out).toContain('<pre class="chat-code" data-lang="ts"><code>const a = 1;\n- not a bullet\n  indented</code></pre>');
    expect(out).toContain("<p>Here is the fix:</p>");
    expect(out).toContain("<p>That&#39;s all.</p>");
    expect(out).not.toContain("<li>");
  });

  test("escapes everything inside it", () => {
    const out = render("```html\n<script>alert(1)</script> & \"x\"\n```");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;");
    expect(out).not.toContain("<script>");
  });

  test("takes no language it can't name safely", () => {
    const out = render('```"><img src=x>\nbody\n```');
    expect(out).not.toContain("<img");
    expect(out).not.toContain('data-lang="');
  });

  test("without a closing fence still shows its lines as code", () => {
    const out = render("Cut short:\n```\nline one\nline two");
    expect(out).toContain("<pre class=\"chat-code\"><code>line one\nline two</code></pre>");
  });

  test("keeps the lists and paragraphs around it", () => {
    const out = render("- one\n```\nx\n```\n- two");
    expect(out).toMatch(/<ul><li>one<\/li><\/ul><pre class="chat-code"><code>x<\/code><\/pre><ul><li>two<\/li><\/ul>/);
  });
});

describe("a diff line's names", () => {
  test("carry a hostile file name and line text as data, never markup", () => {
    const path = 'a"><img src=x onerror=alert(1)>.js';
    const patch = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-</code><script>x</script>\n+&amp; "q" <b>`;
    const out = htmlString(reviewDiffHtml({ text: patch, truncated: false, artifactId: 1 }, null, 1, true));
    expect(out).not.toMatch(/<img|<script/);
    expect(out).toContain('data-diff-file="a&quot;&gt;&lt;img src=x onerror=alert(1)&gt;.js"');
    expect(out).toContain('data-diff-line="1"');
    expect(out).toContain("&lt;/code&gt;&lt;script&gt;x&lt;/script&gt;");
    expect(out).toContain("&amp;amp; &quot;q&quot; &lt;b&gt;");
  });
});

describe("a line comment in the thread", () => {
  test("shows where, the quoted line and the words as three parts", () => {
    const out = htmlString(steerCommentHtml("On src/math.js:1 (removed line) (run #3): Keep this, but name the edge case.\n\n> // TODO: add a subtract(a, b) function next to add")!);
    expect(out).toBe('<div class="chat-steer" data-steer-comment><p class="chat-steer-ref">src/math.js:1 · removed line · run #3</p><pre class="chat-steer-code"><code>// TODO: add a subtract(a, b) function next to add</code></pre><p class="chat-steer-note" style="white-space:pre-wrap">Keep this, but name the edge case.</p></div>');
  });

  test("a comment without a quoted line, or one over several lines, keeps its words", () => {
    const out = htmlString(steerCommentHtml("On a.ts:12 (run #9): First line.\nSecond line.")!);
    expect(out).toContain('<p class="chat-steer-ref">a.ts:12 · run #9</p><p class="chat-steer-note" style="white-space:pre-wrap">First line.\nSecond line.</p>');
    expect(out).not.toContain("chat-steer-code");
  });

  test("escapes a hostile file name, comment and line", () => {
    const out = htmlString(steerCommentHtml('On a"><img src=x onerror=alert(1)>.js:4 (run #1): </p><script>alert(2)</script>\n\n> </code></pre><svg onload=alert(3)>')!);
    expect(out).not.toMatch(/<img|<script|<svg/);
    expect(out).toContain("a&quot;&gt;&lt;img src=x onerror=alert(1)&gt;.js:4 · run #1");
    expect(out).toContain("&lt;/p&gt;&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(out).toContain("<code>&lt;/code&gt;&lt;/pre&gt;&lt;svg onload=alert(3)&gt;</code>");
  });

  test("anything else is not a line comment", () => {
    for (const text of ["Hello", "On src/a.ts:1 (run #2): ", "On src/a.ts (run #2): words", "on src/a.ts:1 (run #2): words", "On src/a.ts:x (run #2): words"]) expect(steerCommentHtml(text)).toBeNull();
  });
});

test("what the Workbench sends reads back as a line comment, the quoted line whole", async () => {
  const { steerMessage } = await import("../browser/line-steer.js");
  const sent = steerMessage({ run: 7, path: "src/a b/c.ts", line: 40, side: "old", code: "  const x = `a` > 1;", note: "Why remove this?\nIt guards the edge." });
  const out = htmlString(steerCommentHtml(sent)!);
  expect(out).toContain('<p class="chat-steer-ref">src/a b/c.ts:40 · removed line · run #7</p>');
  expect(out).toContain("<code>const x = `a` &gt; 1;</code>");
  expect(out).toContain("Why remove this?\nIt guards the edge.");
});
