export type { CodingSession, CodingStatus } from './contracts/coding-workspace.js';
import type { CodingSession } from './contracts/coding-workspace.js';
export type { CodingItem, CodingQuestion, CodingRequest } from './contracts/coding-activity.js';
import type { CodingItem, CodingRequest } from './contracts/coding-activity.js';
export type CodingSnapshot = { session: CodingSession; items: CodingItem[]; requests: CodingRequest[]; revision: number };
export type CodingChanges = { head: string; status: string; diff: string; truncated: boolean };
