/** Popover, drawer, sheet and menu. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import { useCallback, useId, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { openMenu, openOverlay } from "./behavior.js";
import { cn } from "./utils.js";
import { KButton } from "./k-button.js";
import { KNote } from "./k-notice.js";

/**
 * A floating panel (popover, drawer, sheet or menu) rendered while `open`: role=dialog, the app behind inert, Tab
 * kept inside, Escape / Close / the scrim close it, focus returns to `trigger`. A popover and a menu become a
 * bottom sheet on a phone. `onClose` runs however it closes (a removed approval settles as cancelled).
 */
export function KOverlay({ kind, title, sub, trigger, onClose, children }: { kind: "popover" | "drawer" | "sheet" | "menu"; title: string; sub?: string; trigger: HTMLElement | null; onClose: (how: string) => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const closed = useRef(onClose);
  closed.current = onClose;
  const titleId = useId();
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    let settled = false;
    const close = openOverlay(node, trigger, { onClose: how => { settled = true; closed.current(how); } });
    return () => { if (!settled) close(); };
  }, [trigger]);
  const closeButton = <KButton variant="ghost" iconOnly="x" label="Close" sm={kind === "popover" || kind === "menu"} data-k-close="" />;
  const body = kind === "menu" ? <div className="k-menu">{children}</div> : children;
  const inner = kind === "drawer"
    ? <><header className="k-drawer-h"><h2 id={titleId}>{title}</h2>{closeButton}</header><div className="k-drawer-b">{body}</div></>
    : kind === "sheet"
      ? <><div className="k-sheet-h"><div className="k-sheet-ht"><h2 id={titleId}>{title}</h2>{sub && <KNote>{sub}</KNote>}</div>{closeButton}</div><div className="k-sheet-b">{body}</div></>
      : <><div className="k-pop-h"><h3 id={titleId}>{title}</h3>{closeButton}</div>{body}</>;
  const className = kind === "drawer" ? "k-drawer" : kind === "sheet" ? "k-sheet" : cn("k-pop", kind === "menu" && "k-pop-menu");
  return createPortal(<div ref={panel} className={className} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>{inner}</div>, document.body);
}

/** A menu of actions from its trigger (a popover at a desk, a bottom sheet on a phone). */
export function useKMenu(): (trigger: HTMLElement, title: string, items: ReadonlyArray<{ label: string; current?: boolean; act: () => void }>) => void {
  return useCallback((trigger, title, items) => { openMenu(trigger, title, items); }, []);
}
