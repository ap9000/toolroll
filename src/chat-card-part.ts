/** A card as a chat part: its plain text and link buttons always there, the card beside them. */
import { cardOfProposal, cardPlainOf } from "./chat-card.js";
import type { ChatContent } from "./contracts/chat-content.js";
import type { ChatCard } from "./contracts/chat-card.js";
import { cardPlainText } from "./card-render.js";

/** The buttons of a card, as a part's links. */
export const cardLinks = (card: ChatCard): Pick<ChatContent, "link" | "also"> => {
  const [first, ...rest] = card.buttons;
  return { ...(first === undefined ? {} : { link: first }), ...(rest.length === 0 ? {} : { also: rest }) };
};
export const cardContent = (card: ChatCard): ChatContent => ({ text: cardPlainText(card), rich: card, ...cardLinks(card) });
/** A card that can't be read goes out as the plain words kept with it. */
export function cardPart(proposal: { kind: string; payload: Record<string, unknown> }): ChatContent {
  const card = cardOfProposal(proposal);
  return card === null ? { text: cardPlainOf(proposal) } : cardContent(card);
}
export function withoutCard(content: ChatContent): ChatContent {
  const { rich: _rich, ...plain } = content;
  return plain;
}
