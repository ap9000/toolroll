/** Steps on one elapsed-time axis. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import { useState } from "react";
import type { ReactNode } from "react";
import { TIMING_WORDS, dur, timingBars, type TimingRow } from "../../design/kit.js";
import { cn } from "./utils.js";
import { KButton } from "./k-button.js";
import { KIcon } from "./k-icon.js";

export function KTiming({ label = "Steps", chip, rows, scale, foot, head = "Step" }: { label?: string; chip?: ReactNode; rows: readonly TimingRow[]; scale?: number; foot?: ReactNode; head?: string }) {
  const [chart, setChart] = useState(false);
  const bars = timingBars(rows, scale);
  const mark = (st: TimingRow["st"]) => st === "wait" ? <span className="k-wd" /> : st === "q" ? <span className="k-qd" /> : st === "run" ? <span className="k-rund" /> : <KIcon name={st === "ok" ? "check" : "x"} small />;
  return <section className={cn("k-timing", chart && "show-chart")} aria-label={label}>
    <header className="k-timing-h"><h2>{label}</h2><span className="k-timing-state">{chip}</span>
      <KButton className="k-phone-only" variant="ghost" sm label={chart ? "Hide timing" : "Show timing"} aria-expanded={chart} onClick={() => setChart(value => !value)} /></header>
    <div className="k-timing-b">
      <div className="k-crow head" aria-hidden="true"><span /><span>{head}</span><span className="k-crow-lane">Elapsed time</span><span>Status</span><span className="k-crow-s">Time</span></div>
      {rows.map((row, index) => {
        const bar = bars[index];
        const now = row.st === "run" || row.st === "bad" || row.st === "wait";
        return <div key={`${row.name}-${index}`} className={cn("k-crow", row.st, now && "now")}>
          <span className="k-crow-i">{mark(row.st)}</span>
          <span className="k-crow-n">{row.name}<span className="k-crow-sub">{row.sub ?? (row.st === "q" ? "not reached" : "")}</span></span>
          <span className="k-crow-lane">{bar && <i className="k-crow-bar" style={{ left: `${bar.left}%`, width: `${bar.width}%` }} />}</span>
          <span className="k-crow-w">{TIMING_WORDS[row.st]}</span><span className="k-crow-s k-num">{row.st === "q" ? "–" : dur(row.dur)}</span>
        </div>;
      })}
    </div>
    {foot && <div className="k-timing-f">{foot}</div>}
  </section>;
}
