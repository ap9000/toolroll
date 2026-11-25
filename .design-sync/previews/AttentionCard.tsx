import { AttentionCard, Button, KeyValueRow } from "@standing-orders/design";

export function ApproveScope() {
  return (
    <div style={{ maxWidth: 380 }}>
      <AttentionCard
        title="Approve scope for my-tool"
        meta="task #12"
        action={<Button size="sm">Review and sign</Button>}
      >
        <div>
          <KeyValueRow label="runs on" value="claude · sonnet" mono />
          <KeyValueRow label="budget" value="$5.00 per run" mono />
        </div>
      </AttentionCard>
    </div>
  );
}

export function PlainWait() {
  return (
    <div style={{ maxWidth: 380 }}>
      <AttentionCard title="A run is parked on a question" meta="14m waiting" action={<Button size="sm">Answer</Button>} />
    </div>
  );
}
