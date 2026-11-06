// The service worker 0.9.92 installed on phones (docs/plans/plain-toolroll.md P1.4): kept verbatim so new push
// payloads are proved to land on an allowed page through a phone that hasn't updated yet.
// Toolroll — push only; deliberately NO fetch handler (no offline cache of an authenticated console).
const SHAPES = [/^\/next$/, /^\/review$/, /^\/system$/, /^\/routines$/, /^\/routines\/[0-9]+$/, /^\/d\/[0-9]+$/, /^\/r\/[0-9]+$/];
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
