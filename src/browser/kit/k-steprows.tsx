/** The step rows: the steps of one object as the page itself. Rules: src/design/KIT.md; same markup as src/server/kit.ts
 * `stepRows`. */
import type { ReactNode } from "react";
import { STEP_ROW_WORDS, stepRowBodyId, type StepRowMark } from "../../design/kit.js";
import { KChip } from "./k-chip.js";
import { cn } from "./utils.js";

/** One row: its marker, label, one sentence and a time (`at` ISO, `when` its words), and its body. `toggle`: the head is
 * a disclosure button for the body (a finished row); `open` shows the body. A closed body is hidden, never unmounted. */
export type KStepRowItem = { key: string; label: string; mark: StepRowMark; sentence: ReactNode; needsYou?: boolean; current?: boolean;
  at?: string | null; when?: string; body?: ReactNode; toggle?: boolean; open?: boolean };

/** An ordered list of rows: a marker on a rail, the label, one sentence and a time, the row's body under it. The
 * current row is aria-current="step"; `onToggle` opens or closes a toggle row's body. */
export function KStepRows({ label = "Steps", rows, onToggle }: { label?: string; rows: readonly KStepRowItem[]; onToggle?: (key: string) => void }) {
  return <ol className="k-steprows" aria-label={label}>{rows.map(item => {
    const hasBody = item.body !== undefined && item.body !== null && item.body !== "";
    const id = stepRowBodyId(item.key);
    const head = <><span className="k-steprow-label">{item.label}<span className="k-sr">, {STEP_ROW_WORDS[item.mark]}</span></span>
      <span className="k-steprow-say">{item.needsYou && <KChip word="Needs you" tone="needs" />}{item.sentence !== "" && <span>{item.sentence}</span>}</span>
      {item.at ? <time className="k-steprow-time k-num" dateTime={item.at}>{item.when ?? ""}</time> : null}</>;
    return <li key={item.key} className={cn("k-steprow", item.mark)} data-step-row={item.key} aria-current={item.current ? "step" : undefined}>
      <span className="k-steprow-mark" aria-hidden="true" />
      <div className="k-steprow-main">
        {item.toggle && hasBody
          ? <button className="k-steprow-head" type="button" aria-expanded={item.open ? "true" : "false"} aria-controls={id} onClick={() => onToggle?.(item.key)}>{head}</button>
          : <div className="k-steprow-head">{head}</div>}
        {hasBody && <div className="k-steprow-body" id={id} hidden={!item.open}>{item.body}</div>}
      </div>
    </li>;
  })}</ol>;
}
