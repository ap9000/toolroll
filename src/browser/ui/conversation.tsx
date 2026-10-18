/**
 * Adapted from AI Elements Conversation and Message, Copyright 2023 Vercel, Inc.
 * Apache-2.0; source and changes recorded in THIRD_PARTY_NOTICES.md.
 */
import type { ComponentProps, ReactNode } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { Button } from "../components/ui/button.js";
import { cn } from "./primitives.js";

export type ConversationProps = ComponentProps<typeof StickToBottom>;
export function Conversation({ className, ...props }: ConversationProps) {
  // Instant following avoids decorative motion and also respects reduced motion.
  // The upstream hook stops following when a reader scrolls into earlier messages.
  return <StickToBottom className={cn("ui-conversation", className)} initial="instant" resize="instant" role="log" aria-label="Conversation" {...props} />;
}
export function ConversationContent({ className, ...props }: ComponentProps<typeof StickToBottom.Content>) {
  return <StickToBottom.Content className={cn("ui-conversation-content", className)} {...props} />;
}
export function ConversationScrollButton({ className, children, onClick, ...props }: ComponentProps<typeof Button>) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return <Button
    className={cn("ui-conversation-scroll", className)}
    variant="outline"
    size="sm"
    onClick={(event) => {
      onClick?.(event);
      if (!event.defaultPrevented) void scrollToBottom({ animation: "instant" });
    }}
    {...props}
  >{children ?? "Latest message"}</Button>;
}
export function ConversationEmptyState({ className, title = "Start a conversation", description, children, ...props }: ComponentProps<"div"> & { title?: string; description?: string }) {
  return <div className={cn("ui-conversation-empty", className)} {...props}>
    {children ?? <><h2>{title}</h2>{description && <p>{description}</p>}</>}
  </div>;
}
export function Message({ className, from, ...props }: ComponentProps<"article"> & { from: "user" | "assistant" | "system" }) {
  return <article className={cn("ui-message", `ui-message--${from}`, className)} data-from={from} {...props} />;
}
export function MessageContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("ui-message-content", className)} {...props} />;
}
export function MessageActions({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("ui-message-actions", className)} {...props} />;
}
export type MessageRole = "user" | "assistant" | "system";
export type MessageBody = ReactNode;
