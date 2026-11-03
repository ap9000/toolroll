/** The progress line. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { CSSProperties } from "react";
import { STEP_WORDS, stepsFill, type StepItem } from "../../design/kit.js";

/** A few named steps on one line, filled up to where the work is; the current step says so in words. */
export function KSteps({ label = "Progress", steps }: { label?: string; steps: readonly StepItem[] }) {
  const style = { "--k-n": steps.length, "--k-fill": stepsFill(steps) } as CSSProperties;
  return <ol className="k-steps" aria-label={label} style={style}><span className="k-steps-fill" aria-hidden="true" />
    {steps.map(step => <li key={step.label} className={`k-step ${step.state}`} aria-current={step.state === "now" || step.state === "live" || step.state === "failed" ? "step" : undefined}
      aria-label={`${step.label}: ${STEP_WORDS[step.state]}${step.sub ? `, ${step.sub}` : ""}`}>
      <b aria-hidden="true" /><span className="k-step-l" aria-hidden="true">{step.label}</span><span className="k-step-s" aria-hidden="true">{step.sub ?? ""}</span>
    </li>)}</ol>;
}
