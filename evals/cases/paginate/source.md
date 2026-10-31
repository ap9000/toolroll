# paginate

From the unattended real-model pilot's fixed assignments (scripts/fixtures/pilot-scenarios.mjs, `pagination`, category "backend bug"): the original used `splice`, which mutated the caller's array and ignored the edge cases. A build that fixes only the visible test fails the hidden one.

Expected: pass (a correct fix is small and fully specified).

## Status

Draft. The expected outcome above awaits a person's validation (`validatedBy` in case.json); until then this case counts in no canonical campaign.
