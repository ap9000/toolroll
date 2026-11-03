/** The phone dock for the screen’s one primary. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { MouseEvent, ReactNode } from "react";
import { KCount } from "./k-count.js";

/** The phone dock: this screen's one primary (the same act its card hides on a phone). */
export const KDock = ({ children }: { children: ReactNode }) => <div className="k-dock"><div className="k-dock-primary">{children}</div></div>;

/** The dock's Needs-you button (the app shell's, wave B): what waits on this person, one tap from any screen, beside the
 * screen's one primary. `scope` says which projects the count covers. */
export function KDockNeeds({ count, label, scope, onOpen }: { count: number; label: string; scope: string; onOpen: (event: MouseEvent<HTMLButtonElement>) => void }) {
  return <button type="button" className="k-dock-needs" aria-haspopup="dialog" aria-label={`Needs you: ${label}`} onClick={onOpen}>
    <span className="k-dock-needs-l"><span className="k-dot needs" aria-hidden="true" />Needs you<KCount n={count} ink /></span>
    <span className="k-dock-needs-s">{scope}</span>
  </button>;
}
