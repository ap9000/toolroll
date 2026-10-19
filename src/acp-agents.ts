/**
 * The coding agents Toolroll runs over the Agent Client Protocol
 * (docs/plans/acp-adapter.md). Each is its own provider id — readiness,
 * sign-in pauses, routing and spend stay per agent — but they share one
 * transport (acp-client.ts), and a row here is the only place an agent is
 * described.
 *
 * Nothing in a row is trusted to be true of the binary on this machine: an
 * agent runs only after its conformance check passed against that exact
 * binary (attestation), and the check is what proves the argv, the name it
 * gives in `initialize`, and the models it offers. Until then it is listed
 * and refused.
 */
import type { ProviderId } from "./contracts/provider.js";

export const ACP_PROVIDER_IDS = ["opencode", "cursor", "cline", "qwen", "goose"] as const satisfies readonly ProviderId[];
export type AcpProviderId = (typeof ACP_PROVIDER_IDS)[number];

/** The providers with their own adapter and key: everything that is not an ACP agent. */
export type KeyedProviderId = Exclude<ProviderId, AcpProviderId>;

export type AcpAgent = {
  /** How people know it. */
  name: string;
  /** The command looked up on PATH. */
  binary: string;
  /** What starts its ACP server on stdio. */
  argv: readonly string[];
  /** What the operator runs to sign in. */
  signIn: string;
  /** Folders under the home directory that hold its own configuration and sign-in (fenced like other agents' homes). */
  home: readonly string[];
  /** What still reaches a run beside the brief: its own configuration surfaces, in words. */
  configSurface: readonly string[];
};

export const ACP_AGENTS: Readonly<Record<AcpProviderId, AcpAgent>> = {
  opencode: {
    name: "OpenCode",
    binary: "opencode",
    // --pure: "run without external plugins" (opencode 1.18 `acp --help`).
    argv: ["acp", "--pure"],
    signIn: "opencode auth login",
    home: [".config/opencode", ".local/share/opencode"],
    configSurface: ["~/.config/opencode (models, providers, permissions)", "repository AGENTS.md and opencode.json", "its own sign-ins (opencode auth login)"],
  },
  cursor: {
    name: "Cursor",
    binary: "cursor-agent",
    argv: ["acp"],
    signIn: "cursor-agent login",
    home: [".cursor"],
    configSurface: ["~/.cursor (rules, MCP servers)", "repository .cursor/rules and AGENTS.md", "its own sign-in"],
  },
  cline: {
    name: "Cline",
    binary: "cline",
    argv: ["--acp"],
    signIn: "cline auth",
    home: [".cline"],
    configSurface: ["~/.cline (settings, MCP servers)", "repository .clinerules", "its own sign-in"],
  },
  qwen: {
    name: "Qwen Code",
    binary: "qwen",
    argv: ["--acp"],
    signIn: "qwen (then /auth)",
    home: [".qwen"],
    configSurface: ["~/.qwen/settings.json (MCP servers, model settings)", "QWEN.md (global and repository)", "its own sign-in"],
  },
  goose: {
    name: "Goose",
    binary: "goose",
    argv: ["acp"],
    signIn: "goose configure",
    home: [".config/goose"],
    configSurface: ["~/.config/goose (providers, extensions)", "repository .goosehints", "its own sign-in"],
  },
};

const ACP = new Set<string>(ACP_PROVIDER_IDS);

export function isAcpProvider(provider: string): provider is AcpProviderId {
  return ACP.has(provider);
}

/** Whether a profile (or anything carrying a provider) is an ACP agent's: narrows the union. */
export function isAcpProfile<P extends { provider: string }>(profile: P): profile is Extract<P, { provider: AcpProviderId }> {
  return ACP.has(profile.provider);
}

export function isKeyedProvider(provider: ProviderId): provider is KeyedProviderId {
  return !ACP.has(provider);
}

/** Build a per-provider record whose ACP entries all come from one function of the agent's row. */
export function withAcp<K extends KeyedProviderId, V>(keyed: Record<K, V>, acp: (agent: AcpAgent, provider: AcpProviderId) => V): Record<K | AcpProviderId, V> {
  const out = { ...keyed } as Record<K | AcpProviderId, V>;
  for (const provider of ACP_PROVIDER_IDS) out[provider] = acp(ACP_AGENTS[provider], provider);
  return out;
}
