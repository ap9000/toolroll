import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const plan = readFileSync(new URL("../../docs/plans/zod-revamp.md", import.meta.url), "utf8");

it("Item 9 is marked done in the Zod revamp plan, with its Done entry", () => {
  expect(plan).toMatch(/^\| 9 ✅ \| \*\*Lead context bundle\*\* and \*\*project knowledge \/ memory \/ skills\*\* payloads/m);
  const done = plan.slice(plan.indexOf("## Done"));
  expect(done).toMatch(/^- \*\*9\. Lead context and project knowledge, memory and skills\*\*/m);
  for (const contract of ["lead-context.ts", "project-knowledge.ts", "project-memory.ts", "project-skills.ts", "memory-pass.ts"]) expect(done).toContain(`\`${contract}\``);
});
