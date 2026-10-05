import { describe, expect, it } from "vite-plus/test";
import { ProjectId, type AgentSessionProjectCandidate } from "@t3tools/contracts";
import {
  describeCodexProjectImport,
  importCodexProjects,
  selectCodexProjects,
} from "./codexSessionImport.ts";

const projects: AgentSessionProjectCandidate[] = [
  {
    path: "/existing",
    title: "Existing",
    projectId: ProjectId.make("existing"),
    sources: ["codex"],
    threadCount: 30,
    lastActiveAt: null,
    alreadyImported: true,
  },
  {
    path: "/new",
    title: "New",
    sources: ["codex"],
    threadCount: 2,
    lastActiveAt: null,
    alreadyImported: false,
  },
];

describe("Codex project import", () => {
  it("includes existing projects for missing threads and only chosen projects in selected mode", () => {
    expect(selectCodexProjects(projects, "all", new Set(["/new"]))).toEqual(projects);
    expect(selectCodexProjects(projects, "selected", new Set(["/existing"]))).toEqual([
      projects[0],
    ]);
    expect(selectCodexProjects(projects, "selected", new Set(["/removed"]))).toEqual([]);
  });

  it("keeps remote and unavailable projects visible without attempting to import their roots", async () => {
    const unavailable = {
      ...projects[1]!,
      path: "C:/remote",
      unavailableReason: "Connect to its host",
    };
    expect(selectCodexProjects([...projects, unavailable], "all", new Set())).toEqual(projects);
    expect(
      selectCodexProjects([...projects, unavailable], "selected", new Set([unavailable.path])),
    ).toEqual([]);
  });

  it("imports every thread server-side and retains the server's reused project IDs across retries", async () => {
    const projectIds = new Map<string, ProjectId>();
    const calls: string[] = [];
    const result = await importCodexProjects(projects, {
      projectIds,
      newProjectId: () => ProjectId.make("proposed"),
      onProgress: () => {},
      importProject: async (input) => {
        calls.push(input.expectedWorkspaceRoot!);
        expect(input.sessions).toBeUndefined();
        if (input.expectedWorkspaceRoot === "/existing") {
          expect(input.projectId).toBe("existing");
          expect(input.createProject).toBeUndefined();
        } else expect(input.createProject).toEqual({ workspaceRoot: "/new", title: "New" });
        return {
          projectId: ProjectId.make(
            input.expectedWorkspaceRoot === "/existing" ? "existing" : "reused",
          ),
          importedCount: 30,
          existingCount: 1,
          failedCount: 0,
          failedSessions: [],
        };
      },
    });
    expect(calls).toEqual(["/existing", "/new"]);
    expect(result).toEqual({
      projectCount: 2,
      importedCount: 60,
      existingCount: 2,
      failedCount: 0,
      failures: [],
    });
    expect(projectIds.get("/new")).toBe("reused");
  });

  it("keeps completed imports and reports project and thread failures for safe retries", async () => {
    const result = await importCodexProjects(projects, {
      projectIds: new Map(),
      newProjectId: () => ProjectId.make("proposed"),
      onProgress: () => {},
      importProject: async (input) => {
        if (input.projectId === "existing") throw new Error("Unavailable workspace");
        return {
          projectId: input.projectId,
          importedCount: 1,
          existingCount: 2,
          failedCount: 3,
          failedSessions: [],
        };
      },
    });
    expect(result.projectCount).toBe(1);
    expect(result.failures).toEqual(["Existing: Error: Unavailable workspace"]);
    expect(describeCodexProjectImport(result)).toBe(
      "Imported 1 project. Added 1 thread. 2 threads already in T3 Code. 3 threads could not be imported. Retry to add missing threads. 1 project could not be imported. Retry to add missing projects.",
    );
  });
});
