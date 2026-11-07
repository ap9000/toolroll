/**
 * One card, in each app's own form (docs/plans/toolroll-cards.md). A card's values are already scrubbed; here they are
 * made inert for each app, so a value can't become a link, a mention or formatting. Whatever an app can't show comes out
 * as readable text, and every renderer has the same plain version to fall back on.
 */
import type { ChatCard, ChatCardBlock } from "./contracts/chat-card.js";
import { html, joinHtml, type Html } from "./html.js";

type Table = Extract<ChatCardBlock, { kind: "table" }>;
type Chart = Extract<ChatCardBlock, { kind: "chart" }>;

const fit = (text: string, width: number): string => text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;
const asOfWords = (card: ChatCard): string => `From Toolroll's records · ${card.asOf.slice(0, 16).replace("T", " ")} UTC`;
const reportWords = "Reported by the agent, not Toolroll's records";
const moreWords = (more: number): string => `and ${more} more`;
/** A part's heading, unless it only repeats the card's title. */
const headOf = (card: ChatCard, heading: string): string[] => heading === card.title ? [] : [heading];

/** A table as aligned lines, narrow enough for a phone. */
function tableLines(block: Table, maxWidth = 58): string[] {
  const widths = block.columns.map((column, at) => Math.max(column.label.length, ...block.rows.map(row => row[at]!.length)));
  const budget = maxWidth - 2 * (widths.length - 1);
  while (widths.reduce((a, b) => a + b, 0) > budget && Math.max(...widths) > 6) widths[widths.indexOf(Math.max(...widths))]! -= 1;
  const line = (cells: readonly string[]) => cells.map((one, at) => {
    const shown = fit(one, widths[at]!);
    return block.columns[at]!.numeric ? shown.padStart(widths[at]!) : shown.padEnd(widths[at]!);
  }).join("  ").trimEnd();
  return [line(block.columns.map(one => one.label)), ...block.rows.map(line), ...(block.more > 0 ? [moreWords(block.more)] : [])];
}

/** A chart as bars of text: every number stays readable. */
function chartLines(block: Chart): string[] {
  const top = Math.max(...block.points.map(one => one.value), 0);
  const name = Math.min(18, Math.max(...block.points.map(one => one.label.length)));
  return block.points.map(one => `${fit(one.label, name).padEnd(name)} ${"█".repeat(top === 0 ? 0 : Math.round(one.value / top * 14)).padEnd(14)} ${one.shown}`);
}

/** The whole card as plain text: the version every app can show. */
export function cardPlainText(card: ChatCard): string {
  const parts = card.blocks.flatMap((block): string[] => {
    switch (block.kind) {
      case "text": return [block.text];
      case "divider": return [];
      case "facts": return [block.items.map(one => `${one.label}: ${one.value}`).join("\n")];
      case "table": return [[...headOf(card, block.heading), ...(block.origin === "report" ? [reportWords] : []), ...tableLines(block)].join("\n")];
      case "chart": return [[...headOf(card, block.heading), ...chartLines(block)].join("\n")];
    }
  });
  const under = card.actions.length === 0 ? [] : [`Confirm below: ${card.actions.map(one => one.label).join(", ")}`];
  return [card.title, ...parts, asOfWords(card), ...under].join("\n\n");
}

// ---- Slack ---------------------------------------------------------------------------------------------------------

/** In a Slack code block only these need care: nothing inside can become a mention or a link, and it can't close early. */
const slackCode = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("`", "'");
const SLACK_CHART_LABEL = 20;
const SLACK_CHART_TITLE = 50;

function slackChart(block: Chart): Record<string, unknown> | null {
  const unique = new Set(block.points.map(one => one.label)).size === block.points.length;
  if (block.heading.length > SLACK_CHART_TITLE || !unique || block.points.some(one => one.label.length > SLACK_CHART_LABEL)) return null;
  if (block.chart === "pie") {
    if (block.points.some(one => one.value <= 0)) return null;
    return { type: "data_visualization", title: block.heading, chart: { type: "pie", segments: block.points.map(({ label, value }) => ({ label, value })) } };
  }
  return { type: "data_visualization", title: block.heading, chart: { type: block.chart, series: [{ name: block.heading.slice(0, SLACK_CHART_LABEL), data: block.points.map(({ label, value }) => ({ label, value })) }], axis_config: { categories: block.points.map(one => one.label) } } };
}

/** The card as Block Kit, native where Slack has it: one data table and two charts a message, the rest as code blocks. */
export function slackCardBlocks(card: ChatCard, buttons: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ type: "header", text: { type: "plain_text", text: fit(card.title, 150), emoji: false } }];
  const code = (lines: readonly string[]) => ({ type: "section", text: { type: "mrkdwn", text: `\`\`\`${slackCode(lines.join("\n")).slice(0, 2900)}\`\`\``, verbatim: true } });
  let tables = 0, charts = 0;
  for (const block of card.blocks) {
    if (block.kind === "text") out.push({ type: "section", text: { type: "plain_text", text: block.text, emoji: false } });
    else if (block.kind === "divider") out.push({ type: "divider" });
    else if (block.kind === "facts") out.push({ type: "section", fields: block.items.map(one => ({ type: "plain_text", text: `${one.label}: ${one.value || " "}`, emoji: false })) });
    else if (block.kind === "table") {
      if (block.origin === "report") out.push({ type: "context", elements: [{ type: "plain_text", text: reportWords, emoji: false }] });
      if (tables === 0 && block.rows.length > 0) {
        tables++;
        const cell = (text: string) => ({ type: "raw_text", text: text === "" ? " " : text });
        out.push({ type: "data_table", caption: block.heading, rows: [block.columns.map(one => cell(one.label)), ...block.rows.map(row => row.map(cell))] });
        if (block.more > 0) out.push({ type: "context", elements: [{ type: "plain_text", text: moreWords(block.more), emoji: false }] });
      } else out.push(code([...headOf(card, block.heading), ...tableLines(block)]));
    } else {
      const native = charts < 2 ? slackChart(block) : null;
      if (native !== null) { charts++; out.push(native); } else out.push(code([...headOf(card, block.heading), ...chartLines(block)]));
    }
  }
  const under = card.actions.length === 0 ? "" : ` · Confirm below: ${card.actions.map(one => one.label).join(", ")}`;
  out.push({ type: "context", elements: [{ type: "plain_text", text: fit(`${asOfWords(card)}${under}`, 300), emoji: false }] });
  if (buttons.length > 0) out.push({ type: "actions", elements: buttons });
  return out;
}

// ---- Discord -------------------------------------------------------------------------------------------------------

const discordCode = (text: string): string => text.replaceAll("`", "'");

/** The card as one embed: facts as fields, tables and charts as code blocks. `plain` escapes Discord's own syntax. */
export function discordCardEmbed(card: ChatCard, plain: (text: string) => string): Record<string, unknown> {
  const fields: { name: string; value: string; inline?: boolean }[] = [];
  const text: string[] = [];
  for (const block of card.blocks) {
    if (block.kind === "text") text.push(plain(block.text));
    else if (block.kind === "facts") fields.push(...block.items.map(one => ({ name: plain(one.label), value: plain(one.value) || "​", inline: true })));
    else if (block.kind === "table" || block.kind === "chart") {
      const lines = block.kind === "table" ? tableLines(block, 50) : chartLines(block);
      const origin = block.kind === "table" && block.origin === "report" ? `${reportWords}\n` : "";
      fields.push({ name: plain(block.heading), value: `${origin}\`\`\`\n${discordCode(lines.join("\n")).slice(0, 960)}\n\`\`\`` });
    }
  }
  const under = card.actions.length === 0 ? "" : ` · Confirm below: ${card.actions.map(one => one.label).join(", ")}`;
  return { title: plain(card.title).slice(0, 256), ...(text.length === 0 ? {} : { description: text.join("\n\n").slice(0, 4096) }), fields: fields.slice(0, 25), footer: { text: `${asOfWords(card)}${under}`.slice(0, 2048) }, color: 0x297b70 };
}

// ---- Telegram ------------------------------------------------------------------------------------------------------

/** The card as one Telegram message: plain words, tables and charts as `pre` entities, so nothing in a value is parsed. */
export function telegramCardMessage(card: ChatCard): { text: string; entities: { type: "pre" | "bold"; offset: number; length: number }[] } {
  const entities: { type: "pre" | "bold"; offset: number; length: number }[] = [];
  let text = "";
  const add = (words: string, type?: "pre" | "bold") => {
    if (text !== "") text += "\n\n";
    if (type !== undefined) entities.push({ type, offset: text.length, length: words.length });
    text += words;
  };
  add(card.title, "bold");
  for (const block of card.blocks) {
    if (block.kind === "text") add(block.text);
    else if (block.kind === "facts") add(block.items.map(one => `${one.label}: ${one.value}`).join("\n"));
    else if (block.kind === "table") { for (const one of headOf(card, block.heading)) add(one, "bold"); if (block.origin === "report") add(reportWords); add(tableLines(block, 40).join("\n"), "pre"); }
    else if (block.kind === "chart") { for (const one of headOf(card, block.heading)) add(one, "bold"); add(chartLines(block).join("\n"), "pre"); }
  }
  add(asOfWords(card));
  if (card.actions.length > 0) add(`Confirm below: ${card.actions.map(one => one.label).join(", ")}`);
  // Telegram's own limit: past it, the whole plain version, cut, with no entities that could point past the end.
  return text.length <= 4000 ? { text, entities } : { text: cardPlainText(card).slice(0, 4000), entities: [] };
}

// ---- web chat ------------------------------------------------------------------------------------------------------

const CHART_COLORS = 6;

function webChart(block: Chart): Html {
  const top = Math.max(...block.points.map(one => one.value), 0) || 1;
  const summary = block.points.map(one => `${one.label}: ${one.shown}`).join(", ");
  if (block.chart === "bar") {
    return html`<ul class="tc-bars" aria-label="${block.heading}">${joinHtml(block.points.map(one => html`<li><span class="tc-bar-label">${one.label}</span><span class="tc-bar-track"><span class="tc-bar-fill" style="width:${Math.max(1, Math.round(one.value / top * 100))}%"></span></span><span class="tc-bar-value">${one.shown}</span></li>`))}</ul>`;
  }
  if (block.chart === "pie") {
    const total = block.points.reduce((sum, one) => sum + one.value, 0) || 1;
    let at = 0;
    const slices = block.points.map((one, index) => {
      const share = one.value / total * 100, from = at;
      at += share;
      return html`<circle class="tc-slice tc-c${index % CHART_COLORS}" r="15.915" cx="20" cy="20" fill="none" stroke-width="7" pathLength="100" stroke-dasharray="${share.toFixed(3)} ${(100 - share).toFixed(3)}" stroke-dashoffset="${(25 - from).toFixed(3)}"></circle>`;
    });
    return html`<div class="tc-pie"><svg viewBox="0 0 40 40" role="img" aria-label="${`${block.heading}. ${summary}`}">${joinHtml(slices)}</svg><ul class="tc-legend">${joinHtml(block.points.map((one, index) => html`<li><span class="tc-key tc-c${index % CHART_COLORS}"></span>${one.label}<strong>${one.shown}</strong></li>`))}</ul></div>`;
  }
  const width = 300, height = 90, step = block.points.length > 1 ? width / (block.points.length - 1) : 0;
  const xy = block.points.map((one, index) => [Math.round(index * step), Math.round(height - one.value / top * (height - 6) - 2)] as const);
  const line = xy.map(([x, y]) => `${x},${y}`).join(" ");
  return html`<figure class="tc-line"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${`${block.heading}. ${summary}`}">${block.chart === "area" ? html`<polygon class="tc-area" points="0,${height} ${line} ${width},${height}"></polygon>` : ""}<polyline class="tc-stroke" points="${line}" fill="none" vector-effect="non-scaling-stroke"></polyline></svg><figcaption>${summary}</figcaption></figure>`;
}

const partHead = (card: ChatCard, heading: string): Html => joinHtml(headOf(card, heading).map(one => html`<h4>${one}</h4>`));

/** The card as the web chat's own markup; every value is escaped by `html`. */
export function webCardHtml(card: ChatCard): Html {
  const blocks = card.blocks.map(block => {
    switch (block.kind) {
      case "text": return html`<p class="tc-text">${block.text}</p>`;
      case "divider": return html`<hr class="tc-rule">`;
      case "facts": return html`<dl class="tc-facts">${joinHtml(block.items.map(one => html`<div><dt>${one.label}</dt><dd>${one.value}</dd></div>`))}</dl>`;
      case "table": return html`<div class="tc-part">${partHead(card, block.heading)}${block.origin === "report" ? html`<p class="tc-note">${reportWords}</p>` : ""}<div class="tc-scroll"><table class="tc-table"><thead><tr>${joinHtml(block.columns.map(one => html`<th scope="col" class="${one.numeric ? "tc-num" : ""}">${one.label}</th>`))}</tr></thead><tbody>${joinHtml(block.rows.map(row => html`<tr>${joinHtml(row.map((one, at) => html`<td class="${block.columns[at]!.numeric ? "tc-num" : ""}">${one}</td>`))}</tr>`))}</tbody></table></div>${block.more > 0 ? html`<p class="tc-note">${moreWords(block.more)}</p>` : ""}</div>`;
      case "chart": return html`<div class="tc-part">${partHead(card, block.heading)}${webChart(block)}</div>`;
    }
  });
  return html`<div class="tc-card">${joinHtml(blocks)}<p class="tc-note">${asOfWords(card)}</p></div>`;
}


