import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fenceSummaryMarkdown } from "./agent-fence.js";

test("the security guide's fence table is the one in code", () => {
  const guide = readFileSync(join(import.meta.dirname, "..", "docs", "guide", "security.md"), "utf8");
  expect(guide).toContain(fenceSummaryMarkdown());
});
