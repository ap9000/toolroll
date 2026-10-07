/**
 * The pages domain's install assets (moved from serve.ts unchanged): the web app manifest, icons, service worker and
 * typefaces, declared in the route table's edge stage and answered before authentication.
 */
import type { ServerResponse } from "node:http";
import { GEIST_SANS_400, GEIST_SANS_500, GEIST_SANS_600, GEIST_MONO_400, GEIST_MONO_500, GEIST_MONO_600 } from "../fonts.js";

// ---- the phone (arc 3): install assets, served BEFORE authentication — they
// contain nothing secret, and a background service-worker update that met a
// login redirect would fail MIME validation and unregister itself.
const PWA_ICON_192 = "iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAAB1klEQVR42u3bMQ0AIAxFwepgQgD+TSECPJSBQO/nKSA30lhmBwtPYAAZQAaQAWQGkAFkABlAZgAZQPY4oNaHagaQABJAAkgAASSABJAAEkAACSABJIAEEEACSAAJIAEEkAASQAJIAHlHgAASQAJIAAkggASQABJAAgggASSABJAAAkgACSABJIAAAgggASSAss3aAwgggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggORLK0AAASSABJAAEkAACSABJIAEEEACSAAJIAEEkAASQAJIAAEkgASQAHKV4SoDIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAJIfiR6R4AAEkACSAAJIIAEkAASQAIIIAEkgASQAAJIAAkgASSAAAIIIAEkgFxluMoACCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggACSH4kCCCABJIAEkAACSAAJIAEkgAASQAJIAAkggASQABJAAggggAASQAJIAAkggASQABJAAgggASSABJAAAkgACSB9BMgMIAPIADKAzAAygAwgA8gAMgPI7mwDbzYVUJcW7UcAAAAASUVORK5CYII=";
const PWA_ICON_512 = "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAJF0lEQVR42u3VwQ0AEBBFQXU4KUD/TW0R3JzcRLJhfqYCwivDzMy+XHEEZmYCYGZmAmBmZgJgZmYCYGZmAmBmZgJgZmYCYGZmAmBmZgJgZmYCYGZmAmBmZgJgZmYCYGZmAmBmZgJgZmYCYGZmAmBmZgJgZmYCYGZmAmBmZgJgZmYCYGZmAmBmJgBmZiYAZmYmAGZmJgBmZiYAZmYmAGZmJgDb1dYBOCEAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACAIAAACAAAAgAAAIAgAAAIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACAIAAACAAAAgAAAIAgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIAAACAIAAACAAAAgAAAIAgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIAAACAIAAACAAAAgAAAIAIAACACAAAgAgAAIAIAACACAAAgAgAAIAIAACACAAAgAgAAIAIAACACAAAgAgAAIAIAACACAAAgAgAAIAIAACcF+Y5Z5HKgACIAAmAAgAAmACgAAgACYACAACYAKAACAAJgAIAAJgAoAAIAAmAAgAAmACIAACgP/FBEAABEAAzARAAARAAMwEQAAEQADMBEAABEAAzARAAARAAMwEQAAEQADMBEAABEAAzARAAARAAMwEQAAEQADMBEAABEAAzARAAARAAMwEQAAEQADMBEAABEAAzARAAARAAMwEQAAEQABMABAAARAAEwAEAAEwAUAAEAATAAQAATABQAAQABMABAABMAFAABAAEwABEAAEwARAAARAAMwEQAAEQADMBEAABEAAzARAAARAAMwEQAAEQADMBEAABEAAzARAAARAAMwEQAAEQADMBEAABEAAzARAAARAAMwEQAAEQADMBEAABEAAzARAAARAAMwEQAAEAEAABABAAAQAQAAAEAAABAAAAQBAAAAQAAAEAEAABABAAAQAQAAEAEAABABAAAQAQAAEAEAABABAAAQAQAAEAEAABABAAAQAQAAEAEAABABAAAQAQAAEAEAABABAANwcgAAAIAAACAAAAgCAAAAgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIAgAAAIAAACAAAAgCAAAAgAAACIAC/C7Pc80gFQAAEwAQAAUAATAAQAATABAABQABMABAABMAEAAFAAEwAEAAEwAQAAUAATAAEQADwv5gACIAACICZAAiAAAiAmQAIgAAIgJkACIAACICZAAiAAAiAmQAIgAAIgJkACIAACICZAAiAAAiAmQAIgAAIgJkACIAACICZAAiAAAiAmQAIgAAIgJkACIAACICZAAiAAAiAmQAIgAAIgAkAAiAAAmACgAAgACYACAACYAKAACAAJgAIAAJgAoAAIAAmAAgAAmACIAACgACYAAiAAAiAmQAIgAAIgJkACIAACICZAAiAAAiAmQAIgAAIgJkACIAACICZAAiAAAiAmQAIgAAIgJkACIAACICZAAiAAAiAmQAIgAAIgJkACIAACICZAAiAAAiAmQAIgAAACIAAAAiAAAAIAAACAIAAACAAAAgAAAIAgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAmwMQAAAEAAABAEAAABAAAAQAQAAEAEAABABAAAQAQAAEAEAABABAAAQAQAAEAEAABABAAAQAQAAEAEAABABAAAQAQAAEAEAABABAAAQAQAAEAEAABABAAAAQAAAEAAABAEAAABAAAASAJcxyzyMVAAEQABMABAABMAFAABAAEwAEAAEwAUAAEAATAAQAATABQAAQABMABAABMAEQAAHA/2ICIAACIABmAiAAAiAAZgIgAAIgAGYCIAACIABmAiAAAiAAZgIgAAIgAGYCIAACIABmAiAAAiAAZgIgAAIgAGYCIAACIABmAiAAAiAAZgIgAAIgAGYCIAACIABmAiAAAiAAZgIgAAIgACYACIAACIAJAAKAAJgAIAAIgAkAAoAAmAAgAAiACQACgACYACAACIAJgAAIAAJgAiAAAiAAZgIgAAIgAGYCIAACIABmAiAAAiAAZgIgAAIgAGYCIAACIABmAiAAAiAAZgIgAAIgAGYCIAACIABmAiAAAiAAZgIgAAIgAGYCIAACIABmAiAAAiAAZgIgAAIAIAACACAAAgAgAAAIAAACAIAAACAAAAgAAAIAIAACACAAAgAgAAIAIAACACAAAgAgAAIAIAACACAAAgAgAAIAIAACACAAAgAgAAIAIAACACAAAgAgAAIAIAACACAAbg5AAAAQAAAEAAABAEAAABAAAAEQAAABEAAAARAAAAEQAAABEAAAARAAAAEQAAABEAAAARAAAAEQAAABEAAAARAAAAEQAAABEAAAARAAAAEQAAABEAAAAQBAAAAQAAAEAAABAEAAABAAAAEQAAABEAAAARAAAAEQAAABEAAAARAAAAEQAAABEAAAARAAAAEQAAABEAAAARAAAAEQAAABEAAAARAAAAEQAAABcHkAAgCAAAAgAAAIAAACAIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgJmZPT4BMDMTADMzEwAzMxMAMzMTADMzEwAzMxMAMzMTADMzEwAzMxMAMzMTADMzEwAzMxMAMzMTADMzEwAzMxMAMzMTADMzEwAzMxMAMzMTADMzEwAzMxMAMzMTADMzEwAzMwEwMzMBMDMzATAzMwEwMzMBMDOzJzYBVJhD+Nnu218AAAAASUVORK5CYII=";
const PWA_ICON_APPLE = "iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAABqklEQVR42u3aMQ0AIAxFwepgQgD+TSECFHQiYWjv5ylobmwcs2ThBAaHwWFwGBwGh8FhcBgcBofBkW7MparBITgEh+AQHIJDcAgOwQEHHHDAAYfgEByCQ3AIDsEhOASHI8IBBxxwCA7BITgEh+AQHIJDcAgOOOCAQ3AIDsEhOASH4BAcguNPu9PggAMOOOCAAw444IADDjjggAMOOOCAAw444IADDjjggAMOOOCAAw44PPsIDsEhOASH4BAcgkNwCA444IADDjgEh+AQHIJDcAgOwSE44IDDg7EHYzjggAMOOOCAAw444IADDjjggAMOOOCAAw444IADDjjggAMOOOCAAw559hEcgkNwwAEHHHDAITgEh+AQHIJDcAgOwQEHHHDAAYfgEByCQ3B4MIYDDjjggAMOOOCAAw444IADDjjggAMOOOCAAw444IADDjjggAMOOODw7OPZBw7BITgEh+AQHIJDcAgOOOCAAw44BIfgEByCQ3AIDsEhOAQHHHDAITgEh+AQHIJDcAgOwSE44IADDjgecVjbwWFwGBwGh8FhcBgcBofBYeV3AaohX51oqNRKAAAAAElFTkSuQmCC";
const PWA_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="6" y="6" width="88" height="88" rx="14" fill="#1a202c"/><rect x="28" y="28" width="44" height="8" rx="4" fill="#ebebeb"/><rect x="28" y="47" width="44" height="8" rx="4" fill="#ebebeb"/><rect x="28" y="66" width="44" height="8" rx="4" fill="#ebebeb"/></svg>`;
/** The typefaces by route: exact names only, served pre-auth like the icons. */
const FONT_FILES: Record<string, string> = {
  "/fonts/geist-sans-400.woff2": GEIST_SANS_400,
  "/fonts/geist-sans-500.woff2": GEIST_SANS_500,
  "/fonts/geist-sans-600.woff2": GEIST_SANS_600,
  "/fonts/geist-mono-400.woff2": GEIST_MONO_400,
  "/fonts/geist-mono-500.woff2": GEIST_MONO_500,
  "/fonts/geist-mono-600.woff2": GEIST_MONO_600,
};
const PWA_MANIFEST = JSON.stringify({
  name: "Toolroll",
  short_name: "Toolroll",
  id: "/",
  scope: "/",
  start_url: "/",
  display: "standalone",
  background_color: "#0b0b0b",
  theme_color: "#0b0b0b",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
  ],
});
// The service worker, DELIBERATELY MINIMAL: no fetch handler — no cache, no
// offline copy of authenticated pages, nothing intercepting requests. Push
// and the tap, only. notificationclick resolves ONLY allow-listed relative
// paths — the payload URL is data, revalidated, never handed raw to the
// browser (arc 3 finding 5).
const PWA_WORKER = `// Toolroll — push only; deliberately NO fetch handler (no offline cache of an authenticated console).
const SHAPES = [/^\\/next$/, /^\\/review$/, /^\\/system$/, /^\\/routines$/, /^\\/routines\\/[0-9]+$/, /^\\/d\\/[0-9]+$/, /^\\/contest\\/[0-9]+$/, /^\\/r\\/[0-9]+$/];
self.addEventListener("push", function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  var body = typeof data.body === "string" ? data.body : "the console needs you";
  var tag = typeof data.tag === "string" ? data.tag : "toolroll";
  var url = typeof data.url === "string" && SHAPES.some(function (s) { return s.test(data.url); }) ? data.url : "/next";
  if (typeof data.waiting === "number" && data.waiting >= 0 && self.registration.setAppBadge) {
    // A count, never content. Honest no-op where unsupported.
    event.waitUntil(self.registration.setAppBadge(Math.floor(data.waiting)).catch(function () {}));
  }
  event.waitUntil(self.registration.showNotification("Toolroll", { body: body, tag: tag, data: { url: url } }));
});
self.addEventListener("message", function (event) {
  // The page recomputes on load/focus and is authoritative over any stale
  // push: {badge: N} sets, {badge: 0} clears.
  var badge = event.data && typeof event.data.badge === "number" ? event.data.badge : null;
  if (badge === null || !self.registration.setAppBadge) return;
  if (badge <= 0 && self.registration.clearAppBadge) { self.registration.clearAppBadge().catch(function () {}); return; }
  self.registration.setAppBadge(Math.floor(badge)).catch(function () {});
});
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  if (self.registration.clearAppBadge) self.registration.clearAppBadge().catch(function () {});
  var url = event.notification.data && event.notification.data.url;
  var target = new URL(SHAPES.some(function (s) { return s.test(url); }) ? url : "/next", self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: "window" }).then(function (open) {
    for (var i = 0; i < open.length; i++) { if (open[i].url === target && open[i].focus) return open[i].focus(); }
    return clients.openWindow(target);
  }));
});
`;

/**
 * Answers one install asset or typeface (GET only; the caller checks the method), with nosniff and its own
 * conservative caching/CSP. False for any other path: unknown names fall through to the router's refusal.
 */
export function serveInstallAsset(response: ServerResponse, pathname: string, respond: (response: ServerResponse, status: number, type: string, body: string) => void): boolean {
  const asset = (type: string, body: string | Buffer, csp?: string): true => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cache-control", pathname === "/sw.js" ? "no-store" : "public, max-age=3600");
    if (csp !== undefined) response.setHeader("content-security-policy", csp);
    respond(response, 200, type, body as string);
    return true;
  };
  if (pathname === "/manifest.webmanifest") return asset("application/manifest+json", PWA_MANIFEST);
  if (pathname === "/favicon.ico") return asset("image/png", Buffer.from(PWA_ICON_APPLE, "base64"));
  if (pathname === "/icon.svg") return asset("image/svg+xml", PWA_ICON_SVG);
  if (pathname === "/icon-192.png") return asset("image/png", Buffer.from(PWA_ICON_192, "base64"));
  if (pathname === "/icon-512.png") return asset("image/png", Buffer.from(PWA_ICON_512, "base64"));
  if (pathname === "/apple-touch-icon.png") return asset("image/png", Buffer.from(PWA_ICON_APPLE, "base64"));
  if (pathname === "/sw.js") return asset("text/javascript; charset=utf-8", PWA_WORKER, "default-src 'none'");
  // The typefaces: exact-allowlisted like the icons — nothing dynamic rides the path.
  const font = FONT_FILES[pathname];
  if (font !== undefined) return asset("font/woff2", Buffer.from(font, "base64"));
  return false;
}
