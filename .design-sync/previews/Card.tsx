import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  KeyValueRow,
} from "@standing-orders/design";

export function FullComposition() {
  return (
    <Card style={{ maxWidth: 380 }}>
      <CardHeader>
        <CardTitle>my-tool</CardTitle>
        <CardDescription>Personal job scrape and tracking tool</CardDescription>
      </CardHeader>
      <CardContent>
        <KeyValueRow label="default branch" value="main" mono />
        <KeyValueRow label="last built" value="today, 14:32" />
      </CardContent>
      <CardFooter style={{ gap: 8 }}>
        <Button variant="secondary" size="sm">
          Open
        </Button>
        <Button variant="ghost" size="sm">
          Settings
        </Button>
      </CardFooter>
    </Card>
  );
}

export function Simple() {
  return (
    <Card style={{ maxWidth: 380 }}>
      <CardHeader>
        <CardTitle>Nothing waits on you</CardTitle>
        <CardDescription>Two runs are underway — check back in a few minutes.</CardDescription>
      </CardHeader>
    </Card>
  );
}
