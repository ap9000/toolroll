/**
 * Adapted from AI Elements Plan, Confirmation, Sources and Artifact.
 * Copyright 2023 Vercel, Inc. Apache-2.0; see THIRD_PARTY_NOTICES.md.
 * These are presentation only: saved server state owns approval and completion.
 */
import { createContext, useContext } from "react";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "../components/ui/button.js";
import { cn } from "./primitives.js";

export function Plan({ className, ...props }: ComponentProps<"section">) {
  return <section data-slot="plan" className={cn("ui-plan", className)} {...props} />;
}
export function PlanHeader({ className, ...props }: ComponentProps<"header">) {
  return <header className={cn("ui-plan-header", className)} {...props} />;
}
export function PlanTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 className={cn("ui-plan-title", className)} {...props} />;
}
export function PlanContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("ui-plan-content", className)} {...props} />;
}
export function PlanFooter({ className, ...props }: ComponentProps<"footer">) {
  return <footer className={cn("ui-plan-footer", className)} {...props} />;
}

export type ConfirmationState = "pending" | "approved" | "rejected";
const ConfirmationContext = createContext<ConfirmationState | null>(null);
function useConfirmationState() {
  const state = useContext(ConfirmationContext);
  if (!state) throw new Error("Confirmation components must be used within Confirmation");
  return state;
}
export function Confirmation({ state, className, ...props }: ComponentProps<"section"> & { state: ConfirmationState }) {
  return <ConfirmationContext.Provider value={state}>
    <section data-state={state} className={cn("ui-confirmation", className)} {...props} />
  </ConfirmationContext.Provider>;
}
export function ConfirmationTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 className={cn("ui-confirmation-title", className)} {...props} />;
}
export function ConfirmationRequest({ children }: { children?: ReactNode }) {
  return useConfirmationState() === "pending" ? children : null;
}
export function ConfirmationAccepted({ children }: { children?: ReactNode }) {
  return useConfirmationState() === "approved" ? children : null;
}
export function ConfirmationRejected({ children }: { children?: ReactNode }) {
  return useConfirmationState() === "rejected" ? children : null;
}
export function ConfirmationActions({ className, ...props }: ComponentProps<"div">) {
  return useConfirmationState() === "pending" ? <div className={cn("ui-confirmation-actions", className)} {...props} /> : null;
}
export function ConfirmationAction(props: ComponentProps<typeof Button>) {
  return <Button {...props} />;
}

export function Sources({ className, ...props }: ComponentProps<"details">) {
  return <details className={cn("ui-sources", className)} {...props} />;
}
export function SourcesTrigger({ className, count, children, ...props }: ComponentProps<"summary"> & { count: number }) {
  return <summary className={cn("ui-sources-trigger", className)} {...props}>{children ?? `${count} ${count === 1 ? "source" : "sources"}`}</summary>;
}
export function SourcesContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("ui-sources-content", className)} {...props} />;
}
export function Source({ className, title, children, ...props }: ComponentProps<"a">) {
  return <a className={cn("ui-source", className)} rel="noreferrer" {...props}>{children ?? title}</a>;
}

export function Artifact({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("ui-artifact", className)} {...props} />;
}
export function ArtifactHeader({ className, ...props }: ComponentProps<"header">) {
  return <header className={cn("ui-artifact-header", className)} {...props} />;
}
export function ArtifactTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("ui-artifact-title", className)} {...props} />;
}
export function ArtifactContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("ui-artifact-content", className)} {...props} />;
}
export function ArtifactActions({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("ui-artifact-actions", className)} {...props} />;
}
