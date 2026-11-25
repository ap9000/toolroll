import { KeyValueRow } from "@standing-orders/design";

export function ScopeFacts() {
  return (
    <div style={{ maxWidth: 360, background: "var(--background, #0c0e12)", padding: 16, borderRadius: 8 }}>
      <KeyValueRow label="runs on" value="claude · sonnet" mono />
      <KeyValueRow label="auth" value="your subscription" />
      <KeyValueRow label="falls back to" value="gemini · gemini-2.5-pro" mono />
      <KeyValueRow label="budget" value="$5.00 per run" mono />
      <KeyValueRow label="repository" value="~/Documents/my-tool" mono />
    </div>
  );
}
