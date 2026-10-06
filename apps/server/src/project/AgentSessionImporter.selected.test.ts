import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type CodexSessionRef,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("existing-project");
const instance = ProviderInstanceId.make("codex");
const workspaceRoot = "/workspace/project";
const session = (id: string): CodexSessionRef => ({
  providerInstanceId: instance,
  providerSessionId: id,
  filePath: `/codex/sessions/${id}.jsonl`,
});
const outcome = (ref: CodexSessionRef): AgentSessionScanner.AgentSessionRecentThread => ({
  _tag: "Importable",
  source: { ...ref, provider: "codex", size: 100, mtimeMs: 2, device: 3, inode: 4, birthtimeMs: 1 },
  thread: {
    source: "codex",
    ...ref,
    title: ref.providerSessionId,
    model: "gpt-5.4",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:01:00.000Z",
    messages: [
      { role: "user", text: "Original prompt", createdAt: "2026-09-01T10:00:00.000Z" },
      { role: "assistant", text: "Original answer", createdAt: "2026-09-01T10:01:00.000Z" },
    ],
  },
});

const makeTest = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const writes: Array<readonly OrchestrationV2DomainEvent[]> = [];
  const runtimeWrites: Array<unknown> = [];
  const scanCalls: Array<readonly CodexSessionRef[]> = [];
  const bootstrapCalls: Array<unknown> = [];
  let failWrite = false;
  let skipSessions = false;
  let projectSessions: readonly CodexSessionRef[] = [];
  const dependencies = Layer.mergeAll(
    Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
    Layer.mock(AgentSessionScanner.AgentSessionScanner)({
      selectedCodexThreads: (_root, refs, existingNativeIds) => {
        scanCalls.push(refs ?? []);
        return skipSessions
          ? Stream.empty
          : Stream.fromIterable(refs ?? projectSessions).pipe(
              Stream.map((ref) =>
                existingNativeIds?.has(ref.providerSessionId)
                  ? { _tag: "Existing" as const }
                  : outcome(ref),
              ),
            );
      },
      listCodexThreads: () =>
        Effect.succeed({
          sessions: [session("native-existing"), session("native-missing")].map((ref) => ({
            ...ref,
            title: ref.providerSessionId,
            updatedAt: "2026-09-01T10:01:00.000Z",
            archived: false,
            importedThreadId: null,
          })),
          nextCursor: null,
          truncated: false,
        }),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeedSome({ id: projectId, workspaceRoot } as never),
      bootstrap: (input) =>
        Effect.sync(() => {
          bootstrapCalls.push(input);
          return { project: { id: projectId, workspaceRoot } as never, created: false };
        }),
    }),
    Layer.mock(EventSink.EventSinkV2)({
      write: (input) =>
        Effect.gen(function* () {
          if (failWrite)
            return yield* new EventSink.EventSinkWriteError({ eventCount: input.events.length });
          writes.push(input.events);
          yield* Effect.forEach(input.events, (event) => projections.apply(event), {
            discard: true,
          });
          return [];
        }).pipe(
          Effect.mapError(
            (cause) =>
              new EventSink.EventSinkWriteError({ eventCount: input.events.length, cause }),
          ),
        ),
    }),
    Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
      list: () => Effect.succeed([]),
      upsert: (input) =>
        Effect.sync(() => {
          runtimeWrites.push(input);
        }),
      recordImportedTranscript: () => Effect.void,
    }),
    IdAllocator.layer,
  );
  const importer = yield* AgentSessionImporter.AgentSessionImporter.pipe(
    Effect.provide(AgentSessionImporter.layer.pipe(Layer.provide(dependencies))),
  );
  const input = (refs: readonly CodexSessionRef[]) => ({
    projectId,
    expectedWorkspaceRoot: workspaceRoot,
    sessions: refs,
  });
  return {
    importer,
    projections,
    writes,
    runtimeWrites,
    scanCalls,
    bootstrapCalls,
    input,
    failNextWrite: () => {
      failWrite = true;
    },
    allowWrites: () => {
      failWrite = false;
    },
    setProjectSessions: (refs: readonly CodexSessionRef[]) => {
      projectSessions = refs;
    },
    skipScan: () => {
      skipSessions = true;
    },
  };
});

it.effect(
  "adds only missing native conversations and preserves existing T3 history and settings",
  () =>
    Effect.gen(function* () {
      const test = yield* makeTest;
      yield* test.importer.importCodexThreads(test.input([session("native-existing")]));
      const originalId = ThreadId.make("import:codex:native-existing");
      const original = yield* test.projections.getThreadRecords(originalId, [
        "messages",
        "providerThreads",
      ]);
      const customId = ThreadId.make("t3-custom-id");
      const events = test.writes[0]!;
      // Existing conversations need not use the importer's deterministic app-thread ID.
      yield* Effect.forEach(
        events,
        (event) =>
          test.projections.apply({
            ...event,
            threadId: customId,
            payload:
              event.type === "thread.created"
                ? {
                    ...event.payload,
                    id: customId,
                    title: "My T3 title",
                    modelSelection: { instanceId: instance, model: "custom-model" },
                    pinnedAt: event.occurredAt,
                  }
                : event.type === "provider-thread.updated"
                  ? {
                      ...event.payload,
                      id: IdAllocator.deriveProviderThread({
                        driver: event.payload.driver,
                        nativeThreadId: "native-existing",
                        providerInstanceId: ProviderInstanceId.make("codex-other-account"),
                      }),
                      appThreadId: customId,
                    }
                  : { ...event.payload, threadId: customId },
          } as OrchestrationV2DomainEvent),
        { discard: true },
      );
      const before = yield* test.projections.getThreadRecords(customId, [
        "messages",
        "providerThreads",
      ]);
      const writeCount = test.writes.length;
      const result = yield* test.importer.importCodexThreads(
        test.input([session("native-existing"), session("native-missing")]),
      );
      expect(result).toEqual({
        projectId,
        importedCount: 1,
        existingCount: 1,
        failedCount: 0,
        failedSessions: [],
      });
      expect(test.writes).toHaveLength(writeCount + 1);
      expect(test.scanCalls.at(-1)?.map((ref) => ref.providerSessionId)).toEqual([
        "native-missing",
      ]);
      expect(
        yield* test.projections.getThreadRecords(customId, ["messages", "providerThreads"]),
      ).toEqual(before);
      expect(
        yield* test.projections.getThreadRecords(originalId, ["messages", "providerThreads"]),
      ).toEqual(original);
      expect(
        yield* test.projections.getThread(ThreadId.make("import:codex:native-missing")),
      ).toMatchObject({ projectId });
      const retry = yield* test.importer.importCodexThreads(
        test.input([session("native-existing"), session("native-missing")]),
      );
      expect(retry).toEqual({
        projectId,
        importedCount: 0,
        existingCount: 2,
        failedCount: 0,
        failedSessions: [],
      });
      expect(test.writes).toHaveLength(writeCount + 1);
    }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("reuses the workspace's project instead of replacing it or creating a duplicate", () =>
  Effect.gen(function* () {
    const test = yield* makeTest;
    const result = yield* test.importer.importCodexThreads({
      ...test.input([session("new-native")]),
      projectId: ProjectId.make("proposed-new-project"),
      createProject: { workspaceRoot, title: "Codex title" },
    });
    expect(result.projectId).toBe(projectId);
    expect(result.importedCount).toBe(1);
    expect(test.bootstrapCalls).toHaveLength(1);
    expect(
      yield* test.projections.getThread(ThreadId.make("import:codex:new-native")),
    ).toMatchObject({ projectId });
  }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("reports missing source sessions and safely retries a failed event commit", () =>
  Effect.gen(function* () {
    const test = yield* makeTest;
    const ref = session("retry-native");
    test.failNextWrite();
    const failed = yield* test.importer.importCodexThreads(test.input([ref]));
    expect(failed).toEqual({
      projectId,
      importedCount: 0,
      existingCount: 0,
      failedCount: 1,
      failedSessions: [ref],
    });
    expect(test.writes).toHaveLength(0);
    test.allowWrites();
    expect((yield* test.importer.importCodexThreads(test.input([ref]))).importedCount).toBe(1);
    expect(test.writes).toHaveLength(1);
    test.skipScan();
    const absent = session("absent-native");
    expect((yield* test.importer.importCodexThreads(test.input([absent]))).failedSessions).toEqual([
      absent,
    ]);
  }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("marks existing native conversations in the picker", () =>
  Effect.gen(function* () {
    const test = yield* makeTest;
    yield* test.importer.importCodexThreads(test.input([session("native-existing")]));
    const listed = yield* test.importer.listCodexThreads({ workspaceRoot });
    expect(listed.sessions.map((ref) => ref.importedThreadId)).toEqual([
      ThreadId.make("import:codex:native-existing"),
      null,
    ]);
  }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("rejects a changed project directory before importing", () =>
  Effect.gen(function* () {
    const test = yield* makeTest;
    const result = yield* Effect.result(
      test.importer.importCodexThreads({
        ...test.input([session("new-native")]),
        expectedWorkspaceRoot: "/different/project",
      }),
    );
    expect(result._tag).toBe("Failure");
    expect(test.writes).toHaveLength(0);
    expect(test.scanCalls).toHaveLength(0);
  }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

const persistenceStores = Layer.mergeAll(
  ProjectionStore.layer,
  EventStore.layer,
  ProviderSessionRuntime.layer,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));
const persistenceImportLayer = AgentSessionImporter.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      EventSink.layer.pipe(Layer.provideMerge(persistenceStores)),
      Layer.mock(AgentSessionScanner.AgentSessionScanner)({
        selectedCodexThreads: (_root, refs) => Stream.fromIterable((refs ?? []).map(outcome)),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeedSome({ id: projectId, workspaceRoot } as never),
      }),
      IdAllocator.layer,
    ),
  ),
);

it.effect("persists imported messages, native continuation, and event history once in SQLite", () =>
  Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const ref = session("sqlite-native");
    const input = { projectId, expectedWorkspaceRoot: workspaceRoot, sessions: [ref] };
    expect(yield* importer.importCodexThreads(input)).toMatchObject({
      importedCount: 1,
      existingCount: 0,
      failedCount: 0,
      failedSessions: [],
    });
    const threadId = ThreadId.make("import:codex:sqlite-native");
    const before = yield* projections.getThreadRecords(threadId, [
      "messages",
      "turnItems",
      "providerThreads",
    ]);
    expect(before.messages.map((message) => message.text)).toEqual([
      "Original prompt",
      "Original answer",
    ]);
    expect(before.turnItems).toHaveLength(2);
    expect(before.providerThreads[0]?.nativeThreadRef).toMatchObject({
      nativeId: ref.providerSessionId,
      strength: "strong",
    });
    const runtime = yield* runtimes.getByThreadId({ threadId });
    expect(Option.getOrThrow(runtime).resumeCursor).toEqual({ threadId: ref.providerSessionId });
    const log = yield* events.read({ threadId }).pipe(Stream.runCollect);
    expect(log).toHaveLength(6);
    expect(yield* importer.importCodexThreads(input)).toMatchObject({
      importedCount: 0,
      existingCount: 1,
      failedCount: 0,
      failedSessions: [],
    });
    expect(
      yield* projections.getThreadRecords(threadId, ["messages", "turnItems", "providerThreads"]),
    ).toEqual(before);
    expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual(log);
    expect(yield* runtimes.getByThreadId({ threadId })).toEqual(runtime);
  }).pipe(Effect.provide(persistenceImportLayer)),
);

it.effect("imports one copy of a native conversation selected from multiple Codex homes", () =>
  Effect.gen(function* () {
    const test = yield* makeTest;
    const original = session("copied-native");
    const copy = {
      ...original,
      providerInstanceId: ProviderInstanceId.make("other-codex"),
      filePath: "/other-codex/copied-native.jsonl",
    };
    const result = yield* test.importer.importCodexThreads(test.input([original, copy]));
    expect(result).toEqual({
      projectId,
      importedCount: 1,
      existingCount: 1,
      failedCount: 0,
      failedSessions: [],
    });
    expect(test.writes).toHaveLength(1);
  }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect(
  "serializes concurrent imports so two clients cannot add the same conversation twice",
  () =>
    Effect.gen(function* () {
      const test = yield* makeTest;
      const input = test.input([session("concurrent-native")]);
      const results = yield* Effect.all(
        [test.importer.importCodexThreads(input), test.importer.importCodexThreads(input)],
        { concurrency: 2 },
      );
      expect(results.map((result) => result.importedCount)).toEqual([1, 0]);
      expect(results.map((result) => result.existingCount)).toEqual([0, 1]);
      expect(results.flatMap((result) => result.failedSessions)).toEqual([]);
      expect(test.writes).toHaveLength(1);
    }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect(
  "imports all project threads without a 25-thread limit and adds only missing threads on repeat imports",
  () =>
    Effect.gen(function* () {
      const test = yield* makeTest;
      const refs = Array.from({ length: 30 }, (_, index) => session(`project-native-${index}`));
      test.setProjectSessions(refs);
      const input = { projectId, expectedWorkspaceRoot: workspaceRoot };
      expect(yield* test.importer.importCodexThreads(input)).toEqual({
        projectId,
        importedCount: 30,
        existingCount: 0,
        failedCount: 0,
        failedSessions: [],
      });
      const before = yield* test.projections.getThreadRecords(
        ThreadId.make("import:codex:project-native-0"),
        ["messages", "providerThreads"],
      );
      test.setProjectSessions([...refs, session("added-later")]);
      expect(yield* test.importer.importCodexThreads(input)).toEqual({
        projectId,
        importedCount: 1,
        existingCount: 30,
        failedCount: 0,
        failedSessions: [],
      });
      expect(test.writes).toHaveLength(31);
      expect(
        yield* test.projections.getThreadRecords(ThreadId.make("import:codex:project-native-0"), [
          "messages",
          "providerThreads",
        ]),
      ).toEqual(before);
      expect(yield* test.importer.importCodexThreads(input)).toMatchObject({
        importedCount: 0,
        existingCount: 31,
      });
    }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect(
  "reports whole-project commit failures and retries without duplicating successful threads",
  () =>
    Effect.gen(function* () {
      const test = yield* makeTest;
      test.setProjectSessions([session("bulk-failed")]);
      const input = { projectId, expectedWorkspaceRoot: workspaceRoot };
      test.failNextWrite();
      expect(yield* test.importer.importCodexThreads(input)).toMatchObject({
        importedCount: 0,
        failedCount: 1,
      });
      test.allowWrites();
      expect(yield* test.importer.importCodexThreads(input)).toMatchObject({
        importedCount: 1,
        failedCount: 0,
      });
      expect(yield* test.importer.importCodexThreads(input)).toMatchObject({
        importedCount: 0,
        existingCount: 1,
        failedCount: 0,
      });
      expect(test.writes).toHaveLength(1);
    }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);
