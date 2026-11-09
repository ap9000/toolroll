/**
 * How a lead reply reads (docs/plans/lead-voice.md, V3): its length, its sentences, the internal words it says and
 * whether it opens by describing its own steps. Measured on the shaped text a person sees, never the raw reply.
 * A measure for the lead-answer eval's report; nothing gates on it and no reply is rewritten from it.
 */
import { PLAIN_WORDS } from "./plain-words.js";
import { shapeReply } from "./reply-shape.js";

export type ReplyVoice = {
  /** Characters of the shaped reply. */
  characters: number;
  sentences: number;
  /** The `PLAIN_WORDS` rows said outside code, plus "owner" when the reply calls the person "the owner". */
  internalWords: string[];
  /** Opens with its own steps or a filler word ("I checked", "Let me", "Sure,") instead of the answer. */
  narratedOpening: boolean;
};

/** A reply longer than this is counted as long in the eval's report. */
export const LONG_REPLY_CHARACTERS = 320;

const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]+`/g;
const OWNER_AS_ADDRESS = /(?<![\w-])the\s+owner(?![\w-])/i;
const NARRATED_OPENING = /^(?:i\s+checked|i\s+looked\s+at|let\s+me|certainly|sure,)/i;

export function replyVoice(reply: string): ReplyVoice {
  const shaped = shapeReply(reply);
  const prose = shaped.replace(CODE, " ");
  const internalWords = PLAIN_WORDS.filter(one => one.pattern.test(prose)).map(one => one.never);
  if (OWNER_AS_ADDRESS.test(prose)) internalWords.push("owner");
  return {
    characters: shaped.length,
    sentences: prose.split(/(?<=[.!?])\s+|\n+/).filter(part => /[\p{L}\p{N}]/u.test(part)).length,
    internalWords,
    narratedOpening: NARRATED_OPENING.test(shaped.trimStart()),
  };
}

export type VoiceSummary = {
  answers: number;
  medianCharacters: number;
  /** Share of answers over `LONG_REPLY_CHARACTERS`, from 0 to 1. */
  longShare: number;
  /** Internal words said, summed over the answers. */
  internalWords: number;
  narratedOpenings: number;
};

/** One model's answers, summed up for the report. */
export function summarizeVoice(voices: readonly ReplyVoice[]): VoiceSummary {
  const sorted = voices.map(one => one.characters).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    answers: voices.length,
    medianCharacters: sorted.length === 0 ? 0 : sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
    longShare: voices.length === 0 ? 0 : voices.filter(one => one.characters > LONG_REPLY_CHARACTERS).length / voices.length,
    internalWords: voices.reduce((sum, one) => sum + one.internalWords.length, 0),
    narratedOpenings: voices.filter(one => one.narratedOpening).length,
  };
}
