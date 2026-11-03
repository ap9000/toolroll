/** The approval box: four fixed slots in every state. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ReactNode } from "react";
import { cn } from "./utils.js";
import { KNotice } from "./k-notice.js";

/** The four fixed slots: status · supporting text · actions · terms, and the error slot. Same in every state. */
export function KSlots({ wait, status, text, acts, terms, err }: { wait?: boolean; status: ReactNode; text: ReactNode; acts: ReactNode; terms: ReactNode; err?: ReactNode }) {
  return <section className={cn("k-slots", wait && "wait")}>
    <div className="k-slot-status">{status}</div><p className="k-slot-text">{text}</p>
    <div className="k-slot-acts k-acts">{acts}</div><p className="k-slot-terms">{terms}</p>
    <div className="k-slot-err">{err ? <KNotice>{err}</KNotice> : null}</div>
  </section>;
}
