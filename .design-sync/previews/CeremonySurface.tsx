import { CeremonySurface } from "@standing-orders/design";

export function ApproveScope() {
  return (
    <CeremonySurface
      title="Approve this scope"
      digest="a24c72e6603f7829"
      terms={
        <>
          <span>
            Tasks in <strong>my-tool</strong> run on claude (sonnet) under your subscription.
          </span>
          <span>If that runs out, work falls back to gemini on your API key — spend moves to that account.</span>
        </>
      }
      actionLabel="Sign this scope"
    />
  );
}
