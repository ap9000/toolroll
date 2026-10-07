import { expect, test } from "vitest";
import { MCP_ROTATION_REFUSAL, tokenProjects, tokenPurpose, tokenRotationProblem } from "./api-tokens.js";

test("ordinary token purpose defaults explicitly; unknown purpose refuses rotation", () => {
  expect(tokenPurpose(undefined)).toBe("api");
  expect(tokenRotationProblem({ purpose: tokenPurpose(undefined) })).toBeNull();
  for (const purpose of ["mcp", "unknown", null, 1]) {
    expect(tokenRotationProblem({ purpose: tokenPurpose(purpose) })).toBe(MCP_ROTATION_REFUSAL);
  }
});

test("token projects intersect the account, token and OAuth limits without widening either", () => {
  expect(tokenProjects(tokenProjects(["shop", "docs"], ["shop", "bank"]), ["bank", "docs"])).toEqual([]);
  expect(tokenProjects(tokenProjects(["shop", "docs"], ["shop", "bank"]), ["shop", "docs"])).toEqual(["shop"]);
  expect(tokenProjects(null, ["shop"])).toEqual(["shop"]);
  expect(tokenProjects(["shop"], null)).toEqual(["shop"]);
  expect(tokenProjects(null, null)).toBeNull();
  expect(tokenProjects(["shop"], [])).toEqual([]);
});
