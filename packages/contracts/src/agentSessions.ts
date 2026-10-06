import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Coding agent home directories the scanner knows how to read. */
export const AgentSessionSource = Schema.Literals(["claudeAgent", "codex"]);
export type AgentSessionSource = typeof AgentSessionSource.Type;

/** File identity saved with an imported session so bounded retries can skip unchanged history. */
export const AgentSessionImportSource = Schema.Struct({
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  size: NonNegativeInt,
  mtimeMs: Schema.NullOr(Schema.Number),
  device: Schema.Number,
  inode: Schema.NullOr(Schema.Number),
  birthtimeMs: Schema.NullOr(Schema.Number),
});
export type AgentSessionImportSource = typeof AgentSessionImportSource.Type;

export const AgentSessionScanInput = Schema.Struct({
  source: Schema.optional(AgentSessionSource),
  includeArchived: Schema.optional(Schema.Boolean),
});
export type AgentSessionScanInput = typeof AgentSessionScanInput.Type;

/**
 * A directory that at least one agent CLI has run in, suitable for import as a
 * T3 Code project. `alreadyImported` marks candidates that already have an
 * active project rooted at the same path.
 */
/**
 * Git identity of a candidate directory, read from `.git/config` without
 * spawning git. `remoteKey` is the normalized origin URL, shared by every
 * clone of the same repository so the client can group them. `repository`
 * is the GitHub `owner/name` when the origin is on GitHub.
 */
export const AgentSessionProjectGit = Schema.Struct({
  remoteKey: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
});
export type AgentSessionProjectGit = typeof AgentSessionProjectGit.Type;

export const AgentSessionProjectCandidate = Schema.Struct({
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  sources: Schema.Array(AgentSessionSource),
  threadCount: NonNegativeInt,
  lastActiveAt: Schema.NullOr(IsoDateTime),
  alreadyImported: Schema.Boolean,
  unavailableReason: Schema.optional(TrimmedNonEmptyString),
  /**
   * `null` when the directory is not the root of a git repository. Missing on
   * servers that predate the git scan, where the client cannot tell repositories
   * from plain folders and should treat every candidate as a standalone project.
   */
  git: Schema.optionalKey(Schema.NullOr(AgentSessionProjectGit)),
});
export type AgentSessionProjectCandidate = typeof AgentSessionProjectCandidate.Type;

export const AgentSessionScanResult = Schema.Struct({
  candidates: Schema.Array(AgentSessionProjectCandidate),
  scannedAt: IsoDateTime,
  sourceHomes: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  truncated: Schema.optional(Schema.Boolean),
});
export type AgentSessionScanResult = typeof AgentSessionScanResult.Type;

export const AgentSessionImportInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
});
export type AgentSessionImportInput = typeof AgentSessionImportInput.Type;

export class AgentSessionImportProjectNotFoundError extends Schema.TaggedError<AgentSessionImportProjectNotFoundError>()(
  "AgentSessionImportProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist.`;
  }
}

export class AgentSessionImportProjectChangedError extends Schema.TaggedError<AgentSessionImportProjectChangedError>()(
  "AgentSessionImportProjectChangedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' changed directories. Scan for projects again before importing history.`;
  }
}

export const AgentSessionImportResult = Schema.Struct({
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
});
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;

export const CodexSessionRef = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
});
export type CodexSessionRef = typeof CodexSessionRef.Type;

export const CodexSessionListInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  includeArchived: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(NonNegativeInt),
});
export type CodexSessionListInput = typeof CodexSessionListInput.Type;

export const CodexSessionSummary = Schema.Struct({
  ...CodexSessionRef.fields,
  title: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
  archived: Schema.Boolean,
  importedThreadId: Schema.NullOr(ThreadId),
});
export type CodexSessionSummary = typeof CodexSessionSummary.Type;

export const CodexSessionListResult = Schema.Struct({
  sessions: Schema.Array(CodexSessionSummary),
  nextCursor: Schema.NullOr(NonNegativeInt),
  truncated: Schema.Boolean,
});
export type CodexSessionListResult = typeof CodexSessionListResult.Type;

export const CodexSessionImportInput = Schema.Struct({
  ...AgentSessionImportInput.fields,
  createProject: Schema.optional(
    Schema.Struct({
      workspaceRoot: TrimmedNonEmptyString,
      title: TrimmedNonEmptyString,
    }),
  ),
  /** Omit to import every conversation in this project, including archived history. */
  sessions: Schema.optional(
    Schema.Array(CodexSessionRef).check(Schema.isMinLength(1), Schema.isMaxLength(25)),
  ),
});
export type CodexSessionImportInput = typeof CodexSessionImportInput.Type;

export const CodexSessionImportResult = Schema.Struct({
  projectId: ProjectId,
  importedCount: NonNegativeInt,
  existingCount: NonNegativeInt,
  failedSessions: Schema.Array(CodexSessionRef),
  failedCount: NonNegativeInt,
});
export type CodexSessionImportResult = typeof CodexSessionImportResult.Type;

export class AgentSessionScanError extends Schema.TaggedError<AgentSessionScanError>()(
  "AgentSessionScanError",
  {
    operation: Schema.Literals(["read-settings", "read-projects"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to scan agent sessions during ${this.operation}.`;
  }
}
