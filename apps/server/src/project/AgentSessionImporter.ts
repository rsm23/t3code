import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportSource,
  AgentSessionScanError,
  AgentSessionSource,
  CommandId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type CodexSessionImportInput,
  type CodexSessionImportResult,
  type CodexSessionListInput,
  type CodexSessionListResult,
  type CodexSessionRef,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionScanner.AgentSessionThreadMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  {
    readonly importRecentAgentThreads: (
      input: AgentSessionImportInput,
    ) => Effect.Effect<
      AgentSessionImportResult,
      | AgentSessionScanError
      | AgentSessionImportProjectNotFoundError
      | AgentSessionImportProjectChangedError
    >;
    readonly listCodexThreads: (
      input: CodexSessionListInput,
    ) => Effect.Effect<CodexSessionListResult, AgentSessionScanError>;
    readonly importCodexThreads: (
      input: CodexSessionImportInput,
    ) => Effect.Effect<
      CodexSessionImportResult,
      | AgentSessionScanError
      | AgentSessionImportProjectNotFoundError
      | AgentSessionImportProjectChangedError
    >;
  }
>()("t3/project/AgentSessionImporter") {}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const importLock = yield* Semaphore.make(1);
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const importThreads = Effect.fn("AgentSessionImporter.importThreads")(function* (
    input: AgentSessionImportInput,
    selectedSessions?: ReadonlyArray<CodexSessionRef>,
    allCodex = false,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const completedSources = runtimeRows.flatMap((runtime) => {
      const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
      if (
        Option.isNone(payload) ||
        payload.value.cwd === undefined ||
        normalizeProjectPathForComparison(payload.value.cwd) !==
          normalizeProjectPathForComparison(project.workspaceRoot)
      ) {
        return [];
      }
      return payload.value.importedTranscripts ?? [];
    });
    const nativeBindings = yield* projections
      .getNativeThreadBindings(ProviderDriverKind.make("codex"))
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const existingNativeIds = new Set(nativeBindings.map((binding) => binding.nativeId));
    const existingSessions =
      selectedSessions?.filter((session) => existingNativeIds.has(session.providerSessionId)) ?? [];
    const missingSessions = selectedSessions?.filter(
      (session) => !existingNativeIds.has(session.providerSessionId),
    );
    const outcomes =
      allCodex || missingSessions !== undefined
        ? scanner.selectedCodexThreads(project.workspaceRoot, missingSessions, existingNativeIds)
        : scanner.recentThreads(project.workspaceRoot, completedSources);
    const succeeded = new Set<string>();
    const importedThreadIds = new Set<ThreadId>();
    let importedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let existingCount = existingSessions.length;

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Existing") {
          existingCount += 1;
          return;
        }
        if (outcome._tag === "Skipped") {
          failedCount += 1;
          skippedCount += 1;
          return;
        }
        const source = outcome.source;
        const threadId = ThreadId.make(
          `import:${source.providerInstanceId}:${source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const imported = yield* Effect.gen(function* () {
          const thread = outcome.thread;
          if (
            thread.source === "claudeAgent" &&
            !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
          ) {
            return yield* new AgentSessionUnresumableSessionError({
              source: thread.source,
              providerSessionId: thread.providerSessionId,
            });
          }
          if (thread.source === "codex" && existingNativeIds.has(thread.providerSessionId)) {
            if (selectedSessions !== undefined || allCodex) {
              succeeded.add(`${thread.providerInstanceId}\0${thread.providerSessionId}`);
              existingCount += 1;
            }
            return false;
          }
          const existing = yield* projections.getThread(threadId).pipe(
            Effect.map(Option.some),
            Effect.catchTag("ProjectionStoreThreadNotFoundError", () =>
              Effect.succeed(Option.none()),
            ),
          );
          if (Option.isSome(existing)) {
            if (selectedSessions !== undefined || allCodex) {
              succeeded.add(`${thread.providerInstanceId}\0${thread.providerSessionId}`);
              existingCount += 1;
            }
            return false;
          }

          const driver = ProviderDriverKind.make(thread.source);
          const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
          const providerThreadId = idAllocator.derive.providerThread({
            driver,
            nativeThreadId: thread.providerSessionId,
            providerInstanceId: thread.providerInstanceId,
          });
          const createdAt = dateTime(thread.createdAt);
          const updatedAt = dateTime(thread.updatedAt);
          const appThread: OrchestrationV2AppThread = {
            createdBy: "system",
            creationSource: "server",
            id: threadId,
            projectId: input.projectId,
            title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
            providerInstanceId: thread.providerInstanceId,
            modelSelection: { instanceId: thread.providerInstanceId, model },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            linkedPullRequest: null,
            branchPullRequest: null,
            activeProviderThreadId: providerThreadId,
            historyOrigin: "v1_import",
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: threadId,
            },
            forkedFrom: null,
            createdAt,
            updatedAt,
            archivedAt: null,
            settledOverride: "settled",
            settledAt: updatedAt,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          const providerThread: OrchestrationV2ProviderThread = {
            id: providerThreadId,
            driver,
            providerInstanceId: thread.providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver,
              nativeId: thread.providerSessionId,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            createdAt,
            updatedAt,
          };

          yield* runtimes.upsert(
            {
              threadId,
              providerName: driver,
              providerInstanceId: thread.providerInstanceId,
              adapterKey: driver,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              status: "stopped",
              lastSeenAt: thread.updatedAt,
              resumeCursor:
                thread.source === "codex"
                  ? { threadId: thread.providerSessionId }
                  : { threadId, resume: thread.providerSessionId },
              runtimePayload: { cwd: project.workspaceRoot },
            },
            { onConflict: "ignore" },
          );
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
                type: "thread.created",
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: createdAt,
                payload: appThread,
              },
              ...thread.messages.flatMap((message, index) =>
                messageEvents({ threadId, index, message }),
              ),
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
                type: "provider-thread.updated",
                threadId,
                driver,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: updatedAt,
                payload: providerThread,
              },
            ],
          });
          yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not record imported transcript identity", {
                threadId,
                cause,
              }),
            ),
          );
          if (thread.source === "codex") existingNativeIds.add(thread.providerSessionId);
          return true;
        }).pipe(
          Effect.catch((cause) => {
            failedCount += 1;
            return Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
              cause,
            }).pipe(Effect.as(false));
          }),
        );
        if (imported) {
          succeeded.add(
            `${outcome.thread.providerInstanceId}\0${outcome.thread.providerSessionId}`,
          );
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else {
          skippedCount += 1;
        }
      }),
    );

    return {
      importedCount,
      skippedCount,
      existingCount,
      failedCount:
        selectedSessions === undefined
          ? failedCount
          : (missingSessions ?? []).filter(
              (session) =>
                !succeeded.has(`${session.providerInstanceId}\0${session.providerSessionId}`),
            ).length,
      failedSessions: (missingSessions ?? []).filter(
        (session) => !succeeded.has(`${session.providerInstanceId}\0${session.providerSessionId}`),
      ),
    };
  });

  const importRecentAgentThreads = (input: AgentSessionImportInput) =>
    importThreads(input).pipe(
      importLock.withPermits(1),
      Effect.map(({ importedCount, skippedCount }): AgentSessionImportResult => ({
        importedCount,
        skippedCount,
      })),
    );
  const importCodexThreads = Effect.fn("AgentSessionImporter.importCodexThreads")(function* (
    input: CodexSessionImportInput,
  ) {
    let projectId = input.projectId;
    if (input.createProject !== undefined) {
      const created = yield* projects
        .bootstrap({
          commandId: CommandId.make(`codex-import:project:${input.projectId}`),
          projectId: input.projectId,
          title: input.createProject.title,
          workspaceRoot: input.createProject.workspaceRoot,
          createWorkspaceRootIfMissing: false,
        })
        .pipe(
          Effect.catchTag("ProjectConflictError", (error) =>
            projects
              .getById(error.conflictingProjectId)
              .pipe(
                Effect.flatMap((existing) =>
                  Option.isSome(existing)
                    ? Effect.succeed({ project: existing.value, created: false })
                    : Effect.fail(error),
                ),
              ),
          ),
          Effect.mapError(
            (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
          ),
        );
      projectId = created.project.id;
    }
    const result = yield* importThreads(
      { ...input, projectId },
      input.sessions,
      input.sessions === undefined,
    );
    return {
      projectId,
      importedCount: result.importedCount,
      existingCount: result.existingCount,
      failedSessions: result.failedSessions,
      failedCount: result.failedCount,
    } satisfies CodexSessionImportResult;
  }, importLock.withPermits(1));
  const listCodexThreads = Effect.fn("AgentSessionImporter.listCodexThreads")(function* (
    input: CodexSessionListInput,
  ) {
    const listed = yield* scanner.listCodexThreads(input);
    const bindings = yield* projections
      .getNativeThreadBindings(ProviderDriverKind.make("codex"))
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const byNativeId = new Map(bindings.map((binding) => [binding.nativeId, binding.threadId]));
    return {
      ...listed,
      sessions: listed.sessions.map((session) => ({
        ...session,
        importedThreadId: byNativeId.get(session.providerSessionId) ?? null,
      })),
    };
  });
  return AgentSessionImporter.of({
    importRecentAgentThreads,
    listCodexThreads,
    importCodexThreads,
  });
});

export const layer = Layer.effect(AgentSessionImporter, make);
