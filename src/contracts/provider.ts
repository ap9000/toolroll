/**
 * Which harness runs, on which model (provider.ts `AgentSpec`): a provider id and a model id, null for the harness's
 * default. One schema for the pair; `ProviderId` and `AgentSpec` are derived from it. Model ids cross providers
 * ("anthropic/claude-sonnet-4.5", "gpt-5-codex", "opus"): bounded and printable, never leading with a dash (argv
 * safety), and no TOML-hostile characters. That OpenRouter and Gemini need an explicit model runs after parsing.
 *
 * A refusal names its field and never repeats the value it was given: a provider or model field is where a pasted
 * credential would land, and a refusal is shown, logged and sent on.
 */

import { z } from "zod";

export const PROVIDER_ID_VALUES = ["claude", "codex", "openrouter", "gemini"] as const;
export const providerIdSchema = z.enum(PROVIDER_ID_VALUES);

export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const modelIdSchema = z.string().regex(MODEL_ID);

export const agentSpecSchema = z.object({ provider: providerIdSchema, model: modelIdSchema.nullable() });

export type ProviderId = z.infer<typeof providerIdSchema>;
export type AgentSpec = z.infer<typeof agentSpecSchema>;
