import { expect, test } from "vitest";
import { cn } from "./browser/components/ui/utils.js";

test("cn keeps colour roles and merges type and radius utilities", () => {
  expect(cn("text-caption", "text-muted-foreground")).toBe("text-caption text-muted-foreground");
  expect(cn("text-body", "text-caption")).toBe("text-caption");
  expect(cn("rounded-card", "rounded-md")).toBe("rounded-md");
});
