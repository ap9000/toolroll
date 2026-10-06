/** The live grant shared by team execution, proposal cards and confirmation doors. */
import { createHash } from 'node:crypto';
import type { Store, ChatConfig, SubscriptionChatProviderId } from './store.js';
import type { TeamActor, TeamChatAuthorization, TeamSnapshot } from './team-contract.js';
import { ceilingDigestOf } from './principal.js';
import { credentialKeyOf, isDirectChatProvider, priceForConfig, subscriptionCredentialKey } from './converse.js';

export type TeamChatProvider = { config: ChatConfig; key: string | null };
export type TeamChatProviderResolver = () => TeamChatProvider | null;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Subscription-only surfaces can resolve current terms from saved settings.
 * Direct API callers must supply their live key; a stored grant is never proof of it. */
export function subscriptionTeamChatProvider(store: Store): TeamChatProvider | null {
  const config = store.getChatConfig();
  return config && !isDirectChatProvider(config.provider) ? { config, key: null } : null;
}

export function teamChatAuthorization(store: Store, actor: TeamActor, conversation: Pick<NonNullable<TeamSnapshot['selected']>, 'id' | 'threadId' | 'projects'> | null, live: TeamChatProvider | null): TeamChatAuthorization {
  const config = live?.config;
  const empty: TeamChatAuthorization = { enabled: false, provider: config?.provider ?? null, model: config?.model ?? null,
    dailyTurns: config?.dailyTurns ?? 0, weeklyCeilingUsd: null, conversationCeilingUsd: null, termsDigest: '' };
  if (!conversation) return empty;
  if (!live || !config) return { ...empty, waitingReason: 'Choose a chat provider in Settings.' };
  const direct = isDirectChatProvider(config.provider);
  if (direct && (live.key === null || priceForConfig(config) === null)) return { ...empty, waitingReason: 'The configured chat connection is unavailable. Open Settings.' };
  const credential = direct ? credentialKeyOf(config.provider as Parameters<typeof credentialKeyOf>[0], live.key!) : subscriptionCredentialKey(config.provider as SubscriptionChatProviderId);
  const session = store.teamMateSession(actor.name, conversation.threadId);
  const ceiling = direct ? (session ? session.ceilingMicrousd / 1_000_000 : Math.min(5, config.weeklyCeilingMicrousd / 1_000_000)) : null;
  const termsDigest = hash({ version: 1, actor: actor.name, generation: actor.generation, conversation: conversation.id,
    projects: conversation.projects, credential, provider: config.provider, model: config.model,
    daily: config.dailyTurns, weekly: config.weeklyCeilingMicrousd, priceIn: config.priceInMicrousd, priceOut: config.priceOutMicrousd, ceiling });
  const enabled = session !== null && session.approverGeneration === actor.generation && session.endedAt === null
    && session.credentialKey === credential && session.ceilingDigest === ceilingDigestOf(conversation.projects) && session.termsDigest === termsDigest;
  return { enabled, provider: config.provider, model: config.model, dailyTurns: config.dailyTurns,
    weeklyCeilingUsd: direct ? config.weeklyCeilingMicrousd / 1_000_000 : null, conversationCeilingUsd: ceiling, termsDigest };
}

