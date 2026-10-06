import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createAgentSessionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  return {
    scan: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agent-sessions:scan",
      tag: WS_METHODS.agentSessionsScan,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    scanProjects: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-sessions:scan-projects",
      tag: WS_METHODS.agentSessionsScan,
    }),
    importRecent: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-sessions:import",
      tag: WS_METHODS.agentSessionsImport,
    }),
    listCodex: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-sessions:list-codex",
      tag: WS_METHODS.agentSessionsListCodex,
    }),
    importCodex: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-sessions:import-codex",
      tag: WS_METHODS.agentSessionsImportCodex,
    }),
  };
}
