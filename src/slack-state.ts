/** Slack compatibility names for the shared durable transport state. */
import { ChatState } from "./chat-delivery-state.js";
import { chatSchema, chatTables } from "./contracts/chat-tables.js";
import type { Store } from "./store.js";
export { chatHash as slackHash } from "./chat-delivery-state.js";
export type {
  ChatBinding as SlackBinding,
  ChatEvent as SlackEvent,
  ChatPart as SlackPart,
  ChatContent as SlackContent,
} from "./chat-delivery-state.js";
import type { ChatIdentity } from "./chat-delivery-state.js";
export type SlackIdentity = ChatIdentity & { team: string };
export const SLACK_SCHEMA = chatSchema("slack"),
  SLACK_TABLES = chatTables("slack");
export class SlackState extends ChatState {
  constructor(store: Store) {
    super(store, "slack");
  }
}
