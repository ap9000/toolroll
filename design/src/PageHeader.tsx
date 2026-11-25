import type { ReactNode } from "react";

export interface PageHeaderProps {
  /** The screen's name, e.g. "Standing Orders" or "my-tool". */
  title: string;
  /** One quiet line under the title, e.g. "2 waiting · 1 running". */
  subtitle?: string;
  /** Right-aligned actions — usually small secondary or ghost Buttons. */
  actions?: ReactNode;
}

/**
 * Page header — the screen's name over a hairline rule, with optional quiet
 * subtitle and right-aligned actions. No accent color lives here.
 */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="flex items-end justify-between gap-4 border-b pb-4">
      <div>
        <h1 className="m-0 text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="m-0 mt-0.5 text-[13px] text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </header>
  );
}
