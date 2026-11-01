/**
 * Adapted from AI Elements Conversation and Message, Copyright 2023 Vercel, Inc.
 * Apache-2.0; source and changes recorded in THIRD_PARTY_NOTICES.md.
 */
import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { Button } from "../components/ui/button.js";
import { cn } from "./primitives.js";

export type ConversationProps = ComponentProps<typeof StickToBottom>;
export function Conversation({ className, children, ...props }: ConversationProps) {
  // Instant following avoids decorative motion and also respects reduced motion.
  // The upstream hook stops following when a reader scrolls into earlier messages.
  return <StickToBottom className={cn("ui-conversation", className)} initial="instant" resize="instant" role="log" aria-label="Conversation" {...props}>
    {typeof children === "function" ? context => <>{children(context)}<FollowShrinkingBox /></> : <>{children}<FollowShrinkingBox /></>}
  </StickToBottom>;
}
/** The hook follows the thread growing, not its own box shrinking: when a phone's keyboard rises (or the composer grows
 * a line) a reader who was at the newest message stays there instead of it sliding under the composer. */
function FollowShrinkingBox() {
  const { scrollRef, state, scrollToBottom } = useStickToBottomContext();
  // The hook's own follow state, read when the box changes: "at bottom" alone is a 70px proximity, and a reader who
  // scrolled up a little has stopped following (escapedFromLock), so the box shrinking must leave them where they are.
  const following = useRef(() => state.isAtBottom && !state.escapedFromLock);
  following.current = () => state.isAtBottom && !state.escapedFromLock;
  useEffect(() => {
    const box = scrollRef.current;
    if (box === null || typeof ResizeObserver === "undefined") return;
    let height = box.clientHeight;
    const observer = new ResizeObserver(() => {
      const next = box.clientHeight;
      if (next < height && following.current()) void scrollToBottom({ animation: "instant" });
      height = next;
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [scrollRef, scrollToBottom]);
  return null;
}
export function ConversationContent({ className, ...props }: ComponentProps<typeof StickToBottom.Content>) {
  return <StickToBottom.Content className={cn("ui-conversation-content", className)} {...props} />;
}
export function ConversationScrollButton({ className, children, onClick, ...props }: ComponentProps<typeof Button>) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return <Button
    className={cn("ui-conversation-scroll max-[901px]:h-11 max-[901px]:min-h-11", className)}
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
