# dedupe

From the real-model pilot's fixed assignments (scripts/fixtures/pilot-scenarios.mjs, `dedupe`, "backend bug"): `Object.fromEntries` kept the last row, reordered numeric ids and merged `2` with `"2"`.

Expected: pass.

## Status

Draft. The expected outcome above awaits a person's validation (`validatedBy` in case.json); until then this case counts in no canonical campaign.
