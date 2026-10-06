import { createAgentSessionAtoms } from "@t3tools/client-runtime/state/agent-sessions";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Scan of Claude Code / Codex home directories on an environment, surfacing
 * project candidates for the welcome wizard's import step. The scan walks the
 * filesystem server-side, so results are cached briefly and refreshed when the
 * import step remounts.
 */
export const agentSessions = createAgentSessionAtoms(connectionAtomRuntime);
export const agentSessionScan = agentSessions.scan;
export const agentSessionImport = agentSessions.importRecent;
