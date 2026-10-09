/**
 * Every POST form a signed-in page renders carries exactly one CSRF field,
 * the session's own, first (postForm writes them; html`…` refuses a
 * hand-written one). Generated from the route table: every console page,
 * read by an operator with some work in the store.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { T0 } from "../../test/serve-kit.js";
import { addApprover } from "../scope.js";
import { createDecisionServer } from "../serve.js";
import { openStore, type Store } from "../store.js";
import { ROUTES } from "./route-table.js";

let store: Store, server: Server, base: string, dir: string, cookie: string, csrf: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-post-forms-"));
  mkdirSync(join(dir, "config"));
  store = openStore(join(dir, "toolroll.db"));
  for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap");
  store.createTask({ id: "one", title: "A task with a <b>title</b>" }, T0);
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: "/repo/main", configDir: join(dir, "config"), telegramTokenFile: join(dir, "config", "telegram-token") });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: alex.token }), redirect: "manual" });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const html = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
  csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("every rendered POST form carries the session's CSRF field once, first", async () => {
  const pages = ROUTES.filter(route => route.stage === "console" && route.method !== "POST" && route.id !== "live");
  let forms = 0;
  for (const route of pages) {
    const response = await fetch(base + route.sample, { headers: { cookie }, redirect: "manual" });
    if (!(response.headers.get("content-type") ?? "").includes("text/html")) { await response.body?.cancel(); continue; }
    // Rendered markup only: a page script's own source is code, not a form.
    const page = (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    for (const [form, open] of page.matchAll(/(<form\b[^>]*>)[\s\S]*?<\/form>/gi).map(match => [match[0], match[1]!] as const)) {
      if (!/\bmethod="post"/i.test(open)) continue;
      forms += 1;
      const fields = [...form.matchAll(/<input\b[^>]*\bname="csrf"[^>]*>/g)].map(match => match[0]);
      expect(fields, `${route.id}: ${open}`).toEqual([`<input type="hidden" name="csrf" value="${csrf}">`]);
      expect(form.slice(open.length).startsWith(fields[0]!), `${route.id}: ${open}`).toBe(true);
    }
  }
  expect(forms).toBeGreaterThan(40);
});
