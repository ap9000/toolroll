import { Button, PageHeader } from "@standing-orders/design";

export function WithSubtitle() {
  return (
    <div style={{ maxWidth: 420, background: "var(--background, #0c0e12)", padding: 16, borderRadius: 8 }}>
      <PageHeader title="Standing Orders" subtitle="2 waiting · 1 running · 3 built today" />
    </div>
  );
}

export function WithActions() {
  return (
    <div style={{ maxWidth: 420, background: "var(--background, #0c0e12)", padding: 16, borderRadius: 8 }}>
      <PageHeader
        title="my-tool"
        subtitle="main · clean"
        actions={
          <Button variant="secondary" size="sm">
            New task
          </Button>
        }
      />
    </div>
  );
}
