import { expect, test } from "vitest";
import { reclaimDatabase } from "./database-reclaim.js";
import type { Database } from "./store.js";

test("retention reclaims strictly above 25%; migration requires a material freelist", () => {
  for (const [reason, free, pages, wanted] of [
    ["retention", 24, 100, false], ["retention", 25, 100, false], ["retention", 26, 100, true],
    ["migration", 255, 2000, false], ["migration", 256, 2000, true],
  ] as const) {
    const writes: string[] = [];
    const db = { prepare: (sql: string) => ({ get: () => ({ freelist_count: free, page_count: pages, page_size: 4096 }) }), exec: (sql: string) => writes.push(sql) } as unknown as Database;
    expect(reclaimDatabase(db, reason)).toBe(wanted);
    expect(writes).toEqual(wanted ? ["VACUUM", "PRAGMA wal_checkpoint(TRUNCATE)"] : []);
  }
});
