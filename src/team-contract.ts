import type { WorkIndexPage } from './work-index.js';
import type { BrowserActionCard } from './browser-workspace.js';
/** Shared central-team transport contract. Requests never establish actor identity. */
export type TeamActor = { name: string; generation: number };
export type TeamRole = 'viewer' | 'contributor' | 'manager';
export type TeamLead = { id: string; name: string; instructions: string; projects: string[]; revision: number; status: 'active' | 'paused'; createdBy: string };
export type TeamConversation = { id: string; leadId: string; title: string; visibility: 'private' | 'team'; projects: string[]; revision: number; threadId: number; createdBy: string; follow: boolean };
export type TeamParticipant = { account: string; role: TeamRole; active: boolean };
export type TeamMessage = { id: number; author: string; role: 'operator' | 'assistant'; text: string; status: 'queued' | 'running' | 'answered' | 'failed' | 'cancelled' | 'uncertain'; revision: number; createdAt: string; requestId: string | null; turnId: number | null; error: string | null };
export type TeamChatAuthorization = { enabled: boolean; provider: string | null; model: string | null; dailyTurns: number; weeklyCeilingUsd: number | null; conversationCeilingUsd: number | null; termsDigest: string; waitingReason?: string };
/** Browser cards extend the existing CLI summary; both refer to the same saved proposal. */
export type TeamProposal = { id: number; turnId: number; title: string; state: string; href: string; card?: BrowserActionCard };
export type TeamSnapshot = { leads: TeamLead[]; conversations: TeamConversation[]; selected: TeamConversation | null; participants: TeamParticipant[]; messages: TeamMessage[]; canManage: boolean; canSend: boolean; canCreateLead?: boolean; cursor: number; truncated: boolean; projects: string[]; accounts: string[]; chatAuthorization?: TeamChatAuthorization; tasks?: WorkIndexPage; proposals?: TeamProposal[] };
export const TEAM_OPERATIONS = ['list', 'show', 'create-lead', 'update-lead', 'create-conversation', 'member', 'send', 'edit', 'withdraw', 'read', 'authorize', 'follow', 'stop', 'transfer'] as const;
export type TeamOperation = typeof TEAM_OPERATIONS[number];
export type TeamRequest = { operation: TeamOperation; args: Record<string, unknown> };
export type TeamResponse = { version: 1; ok: boolean; code: string; message: string; result?: unknown; snapshot?: TeamSnapshot };
export type TeamExecute = (actor: TeamActor, request: TeamRequest) => Promise<TeamResponse>;
