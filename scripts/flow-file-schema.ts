// Writes docs/flow-file.schema.json from the flow contract (src/contracts/flow.ts). Run: npx tsx scripts/flow-file-schema.ts
import { writeFileSync } from "node:fs";
import { flowFileJsonSchema } from "../src/contracts/flow.js";

writeFileSync(new URL("../docs/flow-file.schema.json", import.meta.url), `${JSON.stringify(flowFileJsonSchema(), null, 2)}\n`);
