export type { CodingSession, CodingStatus } from './contracts/coding-workspace.js';
import type { CodingSession } from './contracts/coding-workspace.js';
export type CodingItem = { id: string; type: string; text: string; status: string | null; clientId?: string };
export type CodingQuestion = { id: string; header: string; question: string; options: { label: string; description: string }[] };
export type CodingRequest = {
  id: string; kind: 'command' | 'files' | 'questions'; method: string;
  title: string; detail: string; questions: CodingQuestion[];
};
export type CodingSnapshot = { session: CodingSession; items: CodingItem[]; requests: CodingRequest[]; revision: number };
export type CodingChanges = { head: string; status: string; diff: string; truncated: boolean };
