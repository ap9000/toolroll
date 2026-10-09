import { html, postForm, type Html } from "./html.js";
import type { RepositoryContext } from './repository-context.js';
export function repositoryContextHtml(repo: string, query: string, result: RepositoryContext | null, csrf: string): Html {
  const root = `/settings/knowledge?repo=${encodeURIComponent(repo)}`;
  return html`<section class="knowledge repository-context"><h2>Relevant code</h2><form method="get" action="/settings/knowledge"><input type="hidden" name="repo" value="${repo}"><label>Find code<input name="q" value="${query}" maxlength="1000" placeholder="A feature, file or symbol"></label><button type="submit">Search</button></form>${
    result === null ? '' : html`<p class="meta">${result.index.engine === 'typescript-ast' ? 'Code relationships' : 'Source search'}${result.mode === 'impact' ? ' · possible change impact' : ''}</p>${
      result.excerpts.length ? result.excerpts.map(one => html`<details><summary>${one.file}:${one.line}${one.symbol ? ` · ${one.symbol}` : ''}</summary><p class="meta">${one.reason}</p><pre>${one.text}</pre><a href="${root}&mode=impact&q=${encodeURIComponent(one.file)}">What this may affect</a></details>`) : html`<p>No matching source was found in this bounded search.</p>`}${
      result.relationships.length ? html`<details><summary>Related files</summary><ul>${result.relationships.map(one => html`<li>${one.from} → ${one.to} · ${one.kind}</li>`)}</ul></details>` : ''}<details><summary>Context details</summary><p>${result.index.status}${result.checkout ? ` · checkout ${result.checkout.head.slice(0, 8)}` : ''}</p>${result.warnings.map(one => html`<p>${one}</p>`)}</details>`}${
    csrf ? html`<details><summary>Refresh code index</summary>${postForm("/settings/knowledge/refresh", html`<p>Builds a local map of TypeScript and JavaScript imports. Uses no model.</p><button type="submit">Refresh index</button>`, { hidden: { repo } })}</details>` : ''}</section>`;
}
