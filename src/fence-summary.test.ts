import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fenceSummaryMarkdown } from "./agent-fence.js";

test("README's fence table is the one in code", () => {
  const readme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");
  expect(readme).toContain(fenceSummaryMarkdown());
});
