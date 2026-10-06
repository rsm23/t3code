import type {
  AgentSessionProjectCandidate,
  CodexSessionImportInput,
  CodexSessionImportResult,
  ProjectId,
} from "@t3tools/contracts";

export type CodexProjectImportMode = "all" | "selected";

/** Search only filters the display; importing all still includes every discovered project. */
export function selectCodexProjects(
  projects: readonly AgentSessionProjectCandidate[],
  mode: CodexProjectImportMode,
  selected: ReadonlySet<string>,
) {
  return projects.filter(
    (project) =>
      project.unavailableReason === undefined && (mode === "all" || selected.has(project.path)),
  );
}

/** Import one project at a time so full transcripts stay on the environment's server. */
export async function importCodexProjects(
  projects: readonly AgentSessionProjectCandidate[],
  options: {
    readonly projectIds: Map<string, ProjectId>;
    readonly newProjectId: () => ProjectId;
    readonly importProject: (input: CodexSessionImportInput) => Promise<CodexSessionImportResult>;
    readonly onProgress: (completed: number, total: number, title: string) => void;
  },
) {
  const totals = { projectCount: 0, importedCount: 0, existingCount: 0, failedCount: 0 };
  const failures: string[] = [];
  for (const [index, project] of projects.entries()) {
    options.onProgress(index, projects.length, project.title);
    const projectId =
      project.projectId ?? options.projectIds.get(project.path) ?? options.newProjectId();
    options.projectIds.set(project.path, projectId);
    try {
      const result = await options.importProject({
        projectId,
        expectedWorkspaceRoot: project.path,
        ...(project.projectId === undefined
          ? { createProject: { workspaceRoot: project.path, title: project.title } }
          : {}),
      });
      options.projectIds.set(project.path, result.projectId);
      totals.projectCount += 1;
      totals.importedCount += result.importedCount;
      totals.existingCount += result.existingCount;
      totals.failedCount += result.failedCount;
    } catch (error) {
      failures.push(`${project.title}: ${String(error)}`);
    }
  }
  return { ...totals, failures };
}

export function describeCodexProjectImport(
  result: Awaited<ReturnType<typeof importCodexProjects>>,
) {
  const parts = [
    `Imported ${result.projectCount} ${result.projectCount === 1 ? "project" : "projects"}. Added ${result.importedCount} ${result.importedCount === 1 ? "thread" : "threads"}.`,
  ];
  if (result.existingCount > 0) parts.push(`${result.existingCount} threads already in T3 Code.`);
  if (result.failedCount > 0)
    parts.push(
      `${result.failedCount} threads could not be imported. Retry to add missing threads.`,
    );
  if (result.failures.length > 0)
    parts.push(
      `${result.failures.length} ${result.failures.length === 1 ? "project" : "projects"} could not be imported. Retry to add missing projects.`,
    );
  return parts.join(" ");
}
