/** Status chips: the five words, one tone each (src/design/kit.ts STATUS). Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import { STATUS, chipOfHeadline, type ChipTone, type StatusKey } from "../../design/kit.js";
import type { Headline } from "../../task-status.js";
import { cn } from "./utils.js";

export function KChip({ word, tone = "", dot = true }: { word: string; tone?: ChipTone; dot?: boolean }) {
  return <span className={cn("k-chip", tone, !dot && "nodot")}>{word}</span>;
}

export const KStatus = ({ status }: { status: StatusKey }) => <KChip word={STATUS[status].word} tone={STATUS[status].tone} />;

export function KHeadlineChip({ headline }: { headline: Headline }) {
  const { word, tone } = chipOfHeadline(headline);
  return <KChip word={word} tone={tone} />;
}
