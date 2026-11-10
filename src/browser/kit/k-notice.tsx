/** Notices: a refusal in place, a neutral system line, a muted note. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import type { ReactNode } from "react";
import { KIcon } from "./k-icon.js";

/** A refusal or problem, where it happened: what went wrong and what didn't change. */
export const KNotice = ({ children }: { children: ReactNode }) => <p className="k-notice" role="alert"><KIcon name="alert" small /><span>{children}</span></p>;

/** One neutral system line (a builder offline, an update): not a failure, never the needs-you mark. */
export const KInfoLine = ({ children }: { children: ReactNode }) => <p className="k-notice info">{children}</p>;

export const KNote = ({ children }: { children: ReactNode }) => <p className="k-note">{children}</p>;
