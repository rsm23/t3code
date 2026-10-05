import * as NodeSqlite from "node:sqlite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const MAX_PROJECTS = 5000;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const LocalProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  rootPaths: Schema.Array(Schema.String),
});
const AppState = Schema.Struct({
  "local-projects": Schema.optional(Schema.Record(Schema.String, LocalProject)),
  "electron-saved-workspace-roots": Schema.optional(Schema.Array(Schema.String)),
  "electron-workspace-root-labels": Schema.optional(Schema.Record(Schema.String, Schema.String)),
  "remote-projects": Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        remotePath: Schema.String,
        label: Schema.optional(Schema.String),
      }),
    ),
  ),
  "thread-workspace-root-hints": Schema.optional(Schema.Record(Schema.String, Schema.String)),
  "thread-project-assignments": Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        projectKind: Schema.String,
        projectId: Schema.String,
      }),
    ),
  ),
});
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(AppState));
const decodeDatabaseProjects = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      path: Schema.String,
    }),
  ),
);
const decodeDatabaseAssignments = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      project_id: Schema.String,
    }),
  ),
);

interface SavedProject {
  readonly path: string;
  readonly title: string;
  readonly remote: boolean;
}
interface Catalog {
  readonly projects: readonly SavedProject[];
  readonly assignedRoots: ReadonlyMap<string, string>;
  readonly truncated: boolean;
}

/** Codex app projects and memberships are separate from transcript working directories. */
export class CodexProjectCatalog extends Context.Service<
  CodexProjectCatalog,
  {
    readonly read: (homePath: string) => Effect.Effect<Catalog>;
  }
>()("t3/project/CodexProjectCatalog") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = Effect.fn("CodexProjectCatalog.read")(function* (homePath: string) {
    let truncated = false;
    const projects = new Map<string, SavedProject>();
    const rootsById = new Map<string, readonly string[]>();
    const assignedRoots = new Map<string, string>();
    const statePath = path.join(homePath, ".codex-global-state.json");
    const state = yield* Effect.gen(function* () {
      const stat = yield* fs.stat(statePath);
      if (Number(stat.size) > MAX_STATE_BYTES) {
        truncated = true;
        return Option.none<typeof AppState.Type>();
      }
      return decodeState(yield* fs.readFileString(statePath));
    }).pipe(Effect.orElseSucceed(() => Option.none<typeof AppState.Type>()));
    const addProject = (root: string, title: string, remote = false) => {
      const trimmed = root.trim();
      if (trimmed.length === 0) return;
      if (projects.size >= MAX_PROJECTS && !projects.has(trimmed)) {
        truncated = true;
        return;
      }
      projects.set(trimmed, {
        path: trimmed,
        title: title.trim() || path.basename(trimmed) || trimmed,
        remote,
      });
    };
    if (Option.isSome(state)) {
      const saved = state.value;
      for (const project of Object.values(saved["local-projects"] ?? {})) {
        rootsById.set(project.id, project.rootPaths);
        for (const root of project.rootPaths) addProject(root, project.name);
      }
      for (const root of saved["electron-saved-workspace-roots"] ?? []) {
        if (!projects.has(root))
          addProject(root, saved["electron-workspace-root-labels"]?.[root] ?? path.basename(root));
      }
      for (const project of saved["remote-projects"] ?? [])
        addProject(project.remotePath, project.label ?? project.remotePath, true);
      const hints = Object.entries(saved["thread-workspace-root-hints"] ?? {});
      truncated ||= hints.length > MAX_PROJECTS;
      for (const [threadId, root] of hints.slice(0, MAX_PROJECTS)) {
        if (projects.get(root)?.remote === false) assignedRoots.set(threadId, root);
      }
      const assignments = Object.entries(saved["thread-project-assignments"] ?? {});
      truncated ||= assignments.length > MAX_PROJECTS;
      for (const [threadId, assignment] of assignments.slice(0, MAX_PROJECTS)) {
        const root = rootsById.get(assignment.projectId)?.[0];
        if (assignment.projectKind === "local" && root) assignedRoots.set(threadId, root);
      }
    }

    const databases = (yield* fs.readDirectory(homePath).pipe(Effect.orElseSucceed(() => [])))
      .filter((name) => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.slice(6, -7)) - Number(a.slice(6, -7)));
    const databasePath = databases[0];
    if (databasePath !== undefined) {
      // Open the provider's database read-only. One read transaction keeps roots
      // and assignments consistent while Codex is running.
      const indexed = yield* Effect.try(() => {
        const database = new NodeSqlite.DatabaseSync(path.join(homePath, databasePath), {
          readOnly: true,
        });
        try {
          database.exec("PRAGMA busy_timeout = 100; BEGIN;");
          const rows = decodeDatabaseProjects(
            database
              .prepare(
                "SELECT p.id, p.name, r.path FROM projects p JOIN project_roots r ON r.project_id = p.id ORDER BY p.position, r.position LIMIT ?",
              )
              .all(MAX_PROJECTS + 1),
          );
          const columns = database.prepare("PRAGMA table_info(threads)").all();
          const assignments = columns.some((column) => column.name === "project_id")
            ? decodeDatabaseAssignments(
                database
                  .prepare(
                    "SELECT id, project_id FROM threads WHERE project_id IS NOT NULL ORDER BY id LIMIT ?",
                  )
                  .all(MAX_PROJECTS + 1),
              )
            : [];
          return { rows, assignments };
        } finally {
          database.close();
        }
      }).pipe(Effect.orElseSucceed(() => null));
      if (indexed !== null) {
        truncated ||=
          indexed.rows.length > MAX_PROJECTS || indexed.assignments.length > MAX_PROJECTS;
        const indexedRoots = new Map<string, string[]>();
        for (const row of indexed.rows.slice(0, MAX_PROJECTS)) {
          addProject(row.path, row.name);
          const roots = indexedRoots.get(row.id) ?? [];
          roots.push(row.path);
          indexedRoots.set(row.id, roots);
        }
        for (const assignment of indexed.assignments.slice(0, MAX_PROJECTS)) {
          const root = indexedRoots.get(assignment.project_id)?.[0];
          if (root) assignedRoots.set(assignment.id, root);
        }
      }
    }
    return { projects: Array.from(projects.values()), assignedRoots, truncated };
  });
  return CodexProjectCatalog.of({ read });
});

export const layer = Layer.effect(CodexProjectCatalog, make);
