/** An action bar: one row, 8px apart. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ReactNode } from "react";

export const KActs = ({ children }: { children: ReactNode }) => <div className="k-acts">{children}</div>;
