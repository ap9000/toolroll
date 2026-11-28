/**
 * Minimal Cloudflare Worker serving Apple's Associated Domains file (AASA) for
 * `webcredentials:toolroll.dev` (ADR 0005). No redirects, strict application/json,
 * immutable cache-friendly headers.
 */
const AASA_BODY = JSON.stringify({
  webcredentials: {
    apps: ["R2LSGQ532L.dev.toolroll.ios"],
  },
});

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/apple-app-site-association" || url.pathname === "/apple-app-site-association") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      return new Response(request.method === "HEAD" ? null : AASA_BODY, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return new Response("Not Found", { status: 404 });
  },
};
