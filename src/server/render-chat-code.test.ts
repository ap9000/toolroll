import { describe, expect, test } from "vitest";
import { htmlString } from "../html.js";
import { renderChatText } from "./render-chat.js";
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
