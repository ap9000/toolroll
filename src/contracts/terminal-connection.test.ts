import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { terminalConnectionSchema, terminalConnectionRefusalSchema } from "./terminal-connection.js";

const cases = JSON.parse(readFileSync(new URL("../../test/fixtures/terminal-connection/cases.json", import.meta.url), "utf8")) as { name: string; valid: boolean; value: unknown }[];
test.each(cases)("connection contract: $name", one => {
  expect(terminalConnectionSchema.safeParse(one.value).success).toBe(one.valid);
});
test("connection refusals have only the version and bounded code", () => {
  for (const error of ["request", "unauthenticated", "credential-purpose", "workspace-unavailable", "contract-unavailable"]) {
    expect(terminalConnectionRefusalSchema.safeParse({ protocol: 1, error }).success).toBe(true);
  }
  expect(terminalConnectionRefusalSchema.safeParse({ protocol: 1, error: "request", token: "secret" }).success).toBe(false);
  expect(terminalConnectionRefusalSchema.safeParse({ protocol: 2, error: "request" }).success).toBe(false);
});
