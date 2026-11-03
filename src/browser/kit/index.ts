/**
 * The revamp kit for React views (src/design/KIT.md). Import from here; the server kit (src/server/kit.ts) writes the
 * same markup for server pages, and ./behavior.ts wires the same behaviour onto both.
 */
export * from "./k-icon.js";
export * from "./k-button.js";
export * from "./k-chip.js";
export * from "./k-count.js";
export * from "./k-tabs.js";
export * from "./k-seg.js";
export * from "./k-field.js";
export * from "./k-select.js";
export * from "./k-switch.js";
export * from "./k-form-row.js";
export * from "./k-radios.js";
export * from "./k-acts.js";
export * from "./k-facts.js";
export * from "./k-notice.js";
export * from "./k-empty.js";
export * from "./k-disclose.js";
export * from "./k-row.js";
export * from "./k-page-header.js";
export * from "./k-doc-header.js";
export * from "./k-overlay.js";
export * from "./k-slots.js";
export * from "./k-approve.js";
export * from "./k-needs-panel.js";
export * from "./k-timing.js";
export * from "./k-not-found.js";
export * from "./k-settings-shell.js";
export * from "./k-dock.js";
export * from "./k-composer.js";
export { composerError, composerSync, composerWorking, closeAll, installKitBehavior, openMenu, openOverlay } from "./behavior.js";
