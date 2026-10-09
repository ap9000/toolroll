import { describe, expect, test } from "vitest";
import { attributes, html, htmlString, isHtml, joinHtml, jsonScript, postForm, replaceMarkup, scriptElement, styleElement, textHtml } from "./html.js";
import { withFormToken } from "./server/request-context.js";

const out = (value: Parameters<typeof htmlString>[0]) => htmlString(value);

describe("html", () => {
  test("escapes every interpolated string, in text and attributes alike", () => {
    const hostile = `"><script>alert('x')</script>&`;
    expect(out(html`<p title="${hostile}">${hostile}</p>`)).toBe(
      `<p title="&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;">&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;</p>`);
  });

  test("markup made here passes through once; never escaped twice", () => {
    const inner = html`<b>${"a & b"}</b>`;
    expect(out(html`<p>${inner}</p>`)).toBe("<p><b>a &amp; b</b></p>");
    expect(out(html`<ul>${["x", "<y>"].map(one => html`<li>${one}</li>`)}</ul>`)).toBe("<ul><li>x</li><li>&lt;y&gt;</li></ul>");
  });

  test("numbers render; null, undefined and booleans render nothing", () => {
    expect(out(html`${1}${2n}${null}${undefined}${false}${true}${0}`)).toBe("120");
    expect(out(html`<p>${false && html`<b>hidden</b>`}</p>`)).toBe("<p></p>");
  });

  test("a look-alike object is not markup", () => {
    const fake = { toString: () => "<b>x</b>" } as unknown as ReturnType<typeof html>;
    expect(isHtml(fake)).toBe(false);
    expect(() => html`${fake}`).toThrow(/cannot interpolate/);
    expect(() => htmlString(fake)).toThrow(/needs Html/);
  });

  test("coercing markup to a string fails under test, so it is never escaped twice downstream", () => {
    const fragment = html`<b>x</b>`;
    expect(() => `${fragment}`).toThrow(/coerced/);
    expect(() => JSON.stringify({ fragment })).toThrow(/serialized/);
  });

  test("joinHtml and textHtml", () => {
    expect(out(joinHtml([html`<i>a</i>`, "b&c"], html`<br>`))).toBe("<i>a</i><br>b&amp;c");
    expect(out(textHtml("<x>"))).toBe("&lt;x&gt;");
  });

  test("attributes: names are checked, true is bare, absent values are left out", () => {
    expect(out(attributes({ class: "a\"b", hidden: true, "data-x": 2, id: null, open: false }))).toBe(` class="a&quot;b" hidden data-x="2"`);
    expect(() => attributes({ "on click": "x" })).toThrow(/bad name/);
  });
});

describe("postForm", () => {
  test("carries the request's one CSRF field first, then revision, return and hidden fields", () => {
    const form = withFormToken("tok\"en", () => postForm("/t/a b/hold", html`<button>Hold</button>`,
      { attrs: { class: "inline" }, projectRevision: 3, returnTo: "/board?x=1&y=2", hidden: { run: 7, note: null } }));
    expect(out(form)).toBe(`<form method="post" action="/t/a b/hold" class="inline"><input type="hidden" name="csrf" value="tok&quot;en">` +
      `<input type="hidden" name="projectRevision" value="3"><input type="hidden" name="return" value="/board?x=1&amp;y=2">` +
      `<input type="hidden" name="run" value="7"><button>Hold</button></form>`);
  });

  test("refuses outside a request, and refuses a hand-written CSRF field", () => {
    expect(() => postForm("/x", "")).toThrow(/outside a console request/);
    expect(() => withFormToken("t", () => postForm("/x", "", { hidden: { csrf: "mine" } }))).toThrow(/adds the CSRF field itself/);
  });

  test("a signed-out form (sign-in, join) has no CSRF field", () => {
    expect(out(postForm("/login", html`<button>Sign in</button>`, { signedOut: true }))).toBe(`<form method="post" action="/login"><button>Sign in</button></form>`);
  });
});

describe("the shell's own elements", () => {
  test("scripts and styles may not end their element", () => {
    expect(out(scriptElement("let a = 1;", { nonce: "n" }))).toBe(`<script nonce="n">let a = 1;</script>`);
    expect(() => scriptElement("x = '</SCRIPT>'")).toThrow();
    expect(() => scriptElement("<!-- x")).toThrow();
    expect(out(styleElement("a{color:red}"))).toBe("<style>a{color:red}</style>");
    expect(() => styleElement("</style><script>")).toThrow();
  });

  test("JSON data islands cannot close their element", () => {
    const island = out(jsonScript({ a: "</script><b>&\u2028" }, { id: "data" }));
    expect(island).toBe(`<script type="application/json" id="data">{"a":"\\u003c/script>\\u003cb>&\\u2028"}</script>`);
    expect(JSON.parse(/>(.*)<\/script>$/.exec(island)![1]!)).toEqual({ a: "</script><b>&\u2028" });
  });
});

describe("replaceMarkup", () => {
  test("replaces matches with markup built by html, and keeps capture positions", () => {
    const page = html`<p><input type="password" name="token"></p><input name="other">`;
    const edited = replaceMarkup(page, /<input (type="password" )?name="(\w+)">/g, (whole, password, name) =>
      password === "" ? html`<i>${whole}</i>` : html`<span data-name="${name}">step-up</span>`);
    expect(out(edited)).toBe(`<p><span data-name="token">step-up</span></p><i>&lt;input name=&quot;other&quot;&gt;</i>`);
  });
});

describe("literal guards", () => {
  test("a template cannot write a POST form or a CSRF field by hand", () => {
    expect(() => html`<form method="post" action="/x"></form>`).toThrow(/postForm/);
    expect(() => html`<FORM class="a" METHOD=POST>`).toThrow(/postForm/);
    expect(() => html`<input type="hidden" name="csrf" value="x">`).toThrow(/CSRF/);
    expect(() => html`<form method="get" action="/search"><input name="q"></form>`).not.toThrow();
  });
});
