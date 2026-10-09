/** The browser bundle is a presentation client. Only these fixed public assets
 * are readable here; authenticated data stays in the existing page handlers. */
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type BrowserWorkspace } from './browser-workspace.js';
import { html, jsonScript, replaceMarkup, scriptElement, type Html } from './html.js';

const assets = new Map<string, { body: Buffer; type: string }>();
function readAsset(name: 'workspace.js' | 'workspace.css' | 'THIRD_PARTY_NOTICES.txt'): Buffer | null {
  // Compiled installation first; the second location supports source-based
  // development/tests after the browser build. No request supplies a file path.
  for (const location of [new URL(`./browser/${name}`, import.meta.url), new URL(`../dist/browser/${name}`, import.meta.url)]) {
    try { return readFileSync(location); } catch { /* An unbuilt checkout retains the HTML surface. */ }
  }
  return null;
}
export function browserAssetsAvailable(): boolean {
  if (assets.size === 3) return true;
  for (const [name, type] of [['workspace.js', 'text/javascript; charset=utf-8'], ['workspace.css', 'text/css; charset=utf-8'], ['THIRD_PARTY_NOTICES.txt', 'text/plain; charset=utf-8']] as const) {
    const body = readAsset(name);
    if (body === null) return false;
    assets.set(`/assets/${name}`, { body, type });
  }
  return true;
}

export function serveBrowserAsset(request: IncomingMessage, response: ServerResponse, path: string): boolean {
  if (path !== '/assets/workspace.js' && path !== '/assets/workspace.css' && path !== '/assets/THIRD_PARTY_NOTICES.txt') return false;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' }); response.end(); return true;
  }
  browserAssetsAvailable();
  const asset = assets.get(path);
  response.writeHead(asset ? 200 : 404, {
    'content-type': asset?.type ?? 'text/plain; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
    ...(asset ? { 'content-length': asset.body.length } : {}),
  });
  response.end(request.method === 'HEAD' ? undefined : asset?.body ?? 'Browser assets are not built.');
  return true;
}

/** Retain the complete native document as the no-JavaScript/unloaded-bundle
 * fallback. React replaces its root only once the local module has loaded.
 * The data script is escaped for HTML parsing, not merely valid JSON. */
export function browserWorkspaceDocument(document: Html, workspace: BrowserWorkspace, nonce: string, functionalScript: string): Html {
  const initialize = `window.addEventListener('standing-orders:workspace-rendered',function initializeWorkspace(){window.removeEventListener('standing-orders:workspace-rendered',initializeWorkspace);${functionalScript}});`;
  // A cross-page fade the browser gives up on rejects its promises; settle them from the head, before the
  // first frame (the app's own listener arrives too late when a page is revealed before the bundle runs).
  const settleFades = `(function(){function s(e){var f=e.viewTransition;if(f)[f.finished,f.ready,f.updateCallbackDone].forEach(function(p){if(p)p.catch(function(){})})}addEventListener('pageswap',s);addEventListener('pagereveal',s)})();`;
  // Each insertion is markup built here; the page's own markup (and its data) is never re-read as a pattern.
  let out = replaceMarkup(document, /<\/head>/, () =>
    // A page showing a password keeps to its one script (the sensitivity contract), so it goes without.
    html`<link rel="stylesheet" href="/assets/workspace.css">${workspace.sensitive ? "" : scriptElement(settleFades, { nonce })}</head>`);
  out = replaceMarkup(out, /<body>/, () => html`<body><div id="standing-orders-workspace">`);
  return replaceMarkup(out, /<\/body>/, () => html`</div>${jsonScript(workspace, { id: "standing-orders-workspace-data", nonce })}${scriptElement(initialize, { nonce })}<script type="module" src="/assets/workspace.js" nonce="${nonce}"></script></body>`);
}
