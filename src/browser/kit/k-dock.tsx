/** The phone dock for the screen’s one primary. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ReactNode } from "react";

/** The phone dock: this screen's one primary (the same act its card hides on a phone). */
export const KDock = ({ children }: { children: ReactNode }) => <div className="k-dock"><div className="k-dock-primary">{children}</div></div>;
