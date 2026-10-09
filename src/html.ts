/**
 * Server HTML, escaped by construction.
 *
 * - `Html` is markup this module made. Nothing else can make one: the class
 *   is private and branded, so a string never passes for markup.
 * - `html` is the only way to write markup. Its literal text is the
 *   author's; every interpolated value is text and is escaped, unless it is
 *   already `Html`. Arrays render in order; null, undefined and booleans
 *   render nothing, so `${cond && html`…`}` reads naturally.
 * - `postForm` is the only way to write a POST form. It adds the request's
 *   CSRF field itself, so a form cannot forget it.
 * - Page sinks (the shell, `respond` for text/html, the workspace's page
 *   snapshot) take `Html` and turn it into bytes with `htmlString`.
 *
 * The script, style and JSON constructors exist for the page shell: their
 * sources are code, and each refuses content that could close its element.
 *
 * This module has no server dependencies (the browser bundle shares time
 * helpers that use it); the server's request context supplies the CSRF token.
 */

const MADE_HERE: unique symbol = Symbol("html");

/** Markup this module made. Only this module holds the token its constructor asks for. */
export class Html {
  readonly #markup: string;
  constructor(token: typeof MADE_HERE, markup: string) {
    if (token !== MADE_HERE) throw new TypeError("Html is made by html`…`");
    this.#markup = markup;
  }
  /** The bytes, for a sink. */
  static markupOf(fragment: Html): string { return fragment.#markup; }
  // Coercing markup to a string (`${fragment}` in a plain template, `+`, join) would lose the brand and
  // be escaped again downstream. Under test that is an error; a running server keeps serving the markup.
  toString(): string {
    if (STRICT) throw new Error("Html coerced to a string: interpolate it with html`…` or hand it to a sink");
    return this.#markup;
  }
  toJSON(): string {
    if (STRICT) throw new Error("Html serialized as JSON: convert it with htmlString() first");
    return this.#markup;
  }
}

// Under test, a coercion is an error to fix; a running server keeps serving the markup.
const STRICT = typeof process !== "undefined" && process.env["VITEST"] !== undefined;

export type HtmlValue = Html | string | number | bigint | boolean | null | undefined | readonly HtmlValue[];

const make = (markup: string): Html => new Html(MADE_HERE, markup);

export const isHtml = (value: unknown): value is Html => value instanceof Html;

/** The markup of an `Html` value, for a sink that writes bytes. */
export function htmlString(fragment: Html): string {
  if (!(fragment instanceof Html)) throw new TypeError("htmlString needs Html");
  return Html.markupOf(fragment);
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeText = (text: string): string => text.replace(/[&<>"']/g, char => ENTITIES[char]!);

function render(value: HtmlValue): string {
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (value instanceof Html) return Html.markupOf(value);
  if (Array.isArray(value)) return (value as readonly HtmlValue[]).map(render).join("");
  if (typeof value === "string") return escapeText(value);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  throw new TypeError(`html: cannot interpolate ${typeof value}`);
}

// A template's literal text is checked once per call site: POST forms and CSRF fields come only from postForm.
const checked = new WeakSet<TemplateStringsArray>();
const POST_FORM = /<form\b[^>]*\bmethod\s*=\s*["']?post\b/i;
const CSRF_FIELD = /\bname\s*=\s*["']?csrf\b/i;
function checkLiteral(strings: TemplateStringsArray): void {
  if (checked.has(strings)) return;
  const text = strings.join("\u0000");
  if (POST_FORM.test(text)) throw new Error("html: write POST forms with postForm, which adds the CSRF field");
  if (CSRF_FIELD.test(text)) throw new Error("html: postForm adds the CSRF field; don't write one");
  checked.add(strings);
}

/** Markup with every interpolation escaped as text, except values that are already `Html`. */
export function html(strings: TemplateStringsArray, ...values: readonly HtmlValue[]): Html {
  checkLiteral(strings);
  let out = strings[0]!;
  for (let index = 0; index < values.length; index++) out += render(values[index]) + strings[index + 1]!;
  return make(out);
}

/** Parts in order, with an optional separator between them. */
export function joinHtml(parts: Iterable<HtmlValue>, separator: HtmlValue = ""): Html {
  const between = render(separator);
  return make([...parts].map(render).join(between));
}

/** Plain text, escaped (for a sink that takes Html when the content is only words). */
export const textHtml = (text: string): Html => make(escapeText(text));

export type AttributeValue = string | number | boolean | null | undefined;
/** Attributes as `name="value"` pairs: true is a bare attribute; false, null and undefined are left out. */
export function attributes(values: Readonly<Record<string, AttributeValue>>): Html {
  let out = "";
  for (const [name, value] of Object.entries(values)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`attributes: bad name ${name}`);
    if (value === false || value === null || value === undefined) continue;
    out += value === true ? ` ${name}` : ` ${name}="${escapeText(String(value))}"`;
  }
  return make(out);
}

export type PostFormOptions = {
  /** Attributes on the form element (class, id, aria-label, data-…). */
  attrs?: Readonly<Record<string, AttributeValue>>;
  /** Hidden fields, after the CSRF field (null and undefined are left out). */
  hidden?: Readonly<Record<string, string | number | null | undefined>>;
  /** The open project's revision this page was rendered under: a stale tab's post is refused. */
  projectRevision?: number | string | null;
  /** Where the action returns afterwards (a same-site path). */
  returnTo?: string | null;
  /** Forms before a session exists (sign-in, sign-up, a join link) have no CSRF field. */
  signedOut?: true;
};

let formToken: () => string | undefined = () => undefined;
/** The server's request context supplies the request's CSRF token (server/request-context.ts). */
export function provideFormToken(source: () => string | undefined): void { formToken = source; }

/**
 * A POST form: the action, the request's one CSRF field, the optional
 * project revision and return fields, other hidden fields, then the body.
 * Outside a console request there is no CSRF to give, so it refuses.
 */
export function postForm(action: string, body: HtmlValue, options: PostFormOptions = {}): Html {
  let csrf: string | null = null;
  if (options.signedOut !== true) {
    const token = formToken();
    if (token === undefined) throw new Error(`postForm(${action}) outside a console request`);
    csrf = token;
  }
  const hidden: Array<[string, string | number]> = [];
  if (csrf !== null) hidden.push(["csrf", csrf]);
  if (options.projectRevision !== undefined && options.projectRevision !== null) hidden.push(["projectRevision", options.projectRevision]);
  if (options.returnTo !== undefined && options.returnTo !== null) hidden.push(["return", options.returnTo]);
  for (const [name, value] of Object.entries(options.hidden ?? {})) {
    if (name === "csrf") throw new Error("postForm adds the CSRF field itself");
    if (value !== null && value !== undefined) hidden.push([name, value]);
  }
  const fields = hidden.map(([name, value]) => `<input type="hidden" name="${escapeText(name)}" value="${escapeText(String(value))}">`).join("");
  return make(`<form method="post" action="${escapeText(action)}"${htmlString(attributes(options.attrs ?? {}))}>${fields}${render(body)}</form>`);
}

/**
 * Markup edited after rendering: each match of `pattern` in the page is replaced by markup the replacer builds
 * (with html`…`), or kept as it was (null), so nothing unescaped can enter. For whole-page passes (a sign-in that
 * stands in for passwords, the browser shell's insertions).
 */
export function replaceMarkup(page: Html, pattern: RegExp, replace: (match: string, ...groups: string[]) => Html | null): Html {
  const groups = new RegExp(`${pattern.source}|`).exec("")!.length - 1;
  return make(htmlString(page).replace(pattern, (match: string, ...rest: unknown[]) => {
    const replaced = replace(match, ...rest.slice(0, groups).map(one => typeof one === "string" ? one : ""));
    return replaced === null ? match : htmlString(replaced);
  }));
}

// ---- the page shell's own elements ---------------------------------------------------------------------------

/** An inline script whose source is code. Its text may not close the element or open a comment. */
export function scriptElement(source: string, attrs: Readonly<Record<string, AttributeValue>> = {}): Html {
  if (/<\/script|<!--/i.test(source)) throw new Error("scriptElement: the source would end its element");
  return make(`<script${htmlString(attributes(attrs))}>${source}</script>`);
}

/** A style element whose rules are code. */
export function styleElement(css: string, attrs: Readonly<Record<string, AttributeValue>> = {}): Html {
  if (/<\/style/i.test(css)) throw new Error("styleElement: the rules would end their element");
  return make(`<style${htmlString(attributes(attrs))}>${css}</style>`);
}

/** Inert JSON for a page script to read: no character of it can end the element. */
export function jsonScript(value: unknown, attrs: Readonly<Record<string, AttributeValue>> = {}): Html {
  // An escaped "<" can neither close the element nor open a comment; the line separators keep it valid script.
  const json = JSON.stringify(value).replace(/[<\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return make(`<script type="application/json"${htmlString(attributes(attrs))}>${json}</script>`);
}
