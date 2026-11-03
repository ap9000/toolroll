/** The two-column settings row. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ReactNode } from "react";
import { cn } from "./utils.js";

/** Two columns: label and one muted line | the control. */
export function KFormRow({ label, hint, variant = "", children }: { label: ReactNode; hint?: ReactNode; variant?: "" | "inline" | "top" | "wide"; children: ReactNode }) {
  return <div className={cn("k-frow", variant)}><div className="k-frow-l"><span className="k-frow-t">{label}</span>{hint && <span className="k-frow-h">{hint}</span>}</div><div className="k-frow-c">{children}</div></div>;
}
