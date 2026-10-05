import {
  ProjectId,
  type AgentSessionProjectCandidate,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  describeCodexProjectImport,
  importCodexProjects,
  selectCodexProjects,
  type CodexProjectImportMode,
} from "@t3tools/client-runtime/codex-session-import";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { LegendList } from "@legendapp/list/react";

import { agentSessions } from "../../state/agentSessions";
import { newProjectId } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";

interface ImportProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly title: string;
}

export function CodexImportSettings({ members }: { members?: readonly ImportProject[] }) {
  const { connectedEnvironments } = useSettingsScope();
  const [target, setTarget] = useState<{
    environmentId: EnvironmentId;
    project: ImportProject | null;
  } | null>(null);
  const targets =
    members === undefined
      ? connectedEnvironments.map((environment) => ({ environment, project: null }))
      : members.flatMap((project) => {
          const environment = connectedEnvironments.find(
            (entry) => entry.environmentId === project.environmentId,
          );
          return environment ? [{ environment, project }] : [];
        });
  if (targets.length === 0) return null;
  return (
    <SettingsSection id="codex-import" title="Import projects">
      {targets.map(({ environment, project }) => (
        <SettingsRow
          key={`${environment.environmentId}:${project?.id ?? "all"}`}
          title={`Codex · ${environment.label}`}
          description={
            environment.serverConfig?.environment?.capabilities.codexSessionImport === true
              ? (project?.workspaceRoot ??
                "Import Codex projects and their threads. Existing projects and threads are kept.")
              : "Update this environment's T3 Code server to import Codex projects."
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={
                environment.serverConfig?.environment?.capabilities.codexSessionImport !== true
              }
              onClick={() => setTarget({ environmentId: environment.environmentId, project })}
            >
              Import from Codex
            </Button>
          }
        />
      ))}
      {target ? (
        <CodexImportDialog
          key={`${target.environmentId}:${target.project?.id ?? "all"}`}
          environmentId={target.environmentId}
          project={target.project}
          onClose={() => setTarget(null)}
        />
      ) : null}
    </SettingsSection>
  );
}

function CodexImportDialog({
  environmentId,
  project,
  onClose,
}: {
  environmentId: EnvironmentId;
  project: ImportProject | null;
  onClose: () => void;
}) {
  const scan = useAtomCommand(agentSessions.scanProjects, { reportFailure: false });
  const importProject = useAtomCommand(agentSessions.importCodex, { reportFailure: false });
  const [projects, setProjects] = useState<readonly AgentSessionProjectCandidate[]>([]);
  const [mode, setMode] = useState<CodexProjectImportMode>("selected");
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(project ? [project.workspaceRoot] : []),
  );
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [sourceHomes, setSourceHomes] = useState<readonly string[]>([]);
  const generation = useRef(0);
  const importInFlight = useRef(false);
  const projectIds = useRef(new Map<string, ProjectId>());
  const load = useCallback(async () => {
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const result = await scan({
        environmentId,
        input: { source: "codex", includeArchived: true },
      });
      if (request !== generation.current) return;
      if (result._tag === "Success") {
        setProjects(result.value.candidates);
        setTruncated(result.value.truncated === true);
        setSourceHomes(result.value.sourceHomes ?? []);
      } else if (!isAtomCommandInterrupted(result))
        setError(String(squashAtomCommandFailure(result)));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, [environmentId, scan]);
  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);
  const chosen = selectCodexProjects(projects, mode, selected);
  const runImport = async () => {
    if (chosen.length === 0 || importInFlight.current) return;
    importInFlight.current = true;
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await importCodexProjects(chosen, {
        projectIds: projectIds.current,
        newProjectId,
        importProject: async (input) => {
          const response = await importProject({ environmentId, input });
          if (response._tag === "Success") return response.value;
          throw new Error(String(squashAtomCommandFailure(response)));
        },
        onProgress: (completed, total, title) =>
          setProgress(`Importing project ${completed + 1} of ${total}: ${title}`),
      });
      setNotice(describeCodexProjectImport(result));
      await load();
      if (result.failures.length > 0) setError(result.failures.join("\n"));
    } finally {
      importInFlight.current = false;
      setImporting(false);
      setProgress(null);
    }
  };
  const search = query.trim().toLocaleLowerCase();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !importing) onClose();
      }}
    >
      <DialogPopup showCloseButton={!importing}>
        <DialogHeader>
          <DialogTitle>Import projects from Codex</DialogTitle>
          <DialogDescription>
            Import projects with all their threads, including archived history. Existing T3 projects
            are reused and only missing threads are added.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <div className="flex gap-2" role="group" aria-label="Projects to import">
              <Button
                variant={mode === "all" ? "default" : "outline"}
                aria-pressed={mode === "all"}
                disabled={busy || importing}
                onClick={() => setMode("all")}
              >
                Import all projects
              </Button>
              <Button
                variant={mode === "selected" ? "default" : "outline"}
                aria-pressed={mode === "selected"}
                disabled={busy || importing}
                onClick={() => setMode("selected")}
              >
                Select projects
              </Button>
            </div>
            <Input
              aria-label="Search Codex projects"
              placeholder="Search projects…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              disabled={importing}
            />
            {error ? (
              <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {notice ? (
              <p role="status" className="text-sm">
                {notice}
              </p>
            ) : null}
            {truncated ? (
              <p className="text-sm text-muted-foreground">
                Discovery reached its scan limit. Only discovered projects and threads can be
                imported.
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {projects.length} projects found ·{" "}
              {projects.filter((candidate) => candidate.unavailableReason !== undefined).length}{" "}
              unavailable
            </p>
            <LegendList
              data={projects.filter((candidate) =>
                `${candidate.title} ${candidate.path}`.toLocaleLowerCase().includes(search),
              )}
              keyExtractor={(candidate) => candidate.path}
              extraData={{ selected, mode, busy, importing }}
              estimatedItemSize={90}
              recycleItems
              style={{ height: 320 }}
              renderItem={({ item: candidate }) => (
                <label className="flex items-start gap-3 border-b border-border py-3">
                  <Checkbox
                    aria-label={`Import project ${candidate.title}`}
                    checked={
                      candidate.unavailableReason === undefined &&
                      (mode === "all" || selected.has(candidate.path))
                    }
                    disabled={
                      busy ||
                      importing ||
                      mode === "all" ||
                      candidate.unavailableReason !== undefined
                    }
                    onCheckedChange={(checked) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (checked) next.add(candidate.path);
                        else next.delete(candidate.path);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0 text-sm">
                    <span className="block break-words">{candidate.title}</span>
                    <span className="block break-all text-xs text-muted-foreground">
                      {candidate.path}
                    </span>
                    {candidate.unavailableReason ? (
                      <span className="block text-xs text-muted-foreground">
                        {candidate.unavailableReason}
                      </span>
                    ) : null}
                    {candidate.unavailableReason === undefined ? (
                      <span className="text-xs text-muted-foreground">
                        {candidate.threadCount} Codex threads ·{" "}
                        {candidate.projectId
                          ? "Existing project — add missing threads"
                          : "New project"}
                      </span>
                    ) : null}
                  </span>
                </label>
              )}
              ListEmptyComponent={
                !busy ? (
                  <p className="py-4 text-sm text-muted-foreground">
                    No matching Codex projects found on this environment.
                  </p>
                ) : null
              }
            />
            {busy || progress ? (
              <p role="status" className="text-sm text-muted-foreground">
                {progress ?? "Finding Codex projects…"}
              </p>
            ) : null}
            {sourceHomes.length > 0 ? (
              <p className="break-all text-xs text-muted-foreground">
                Codex home: {sourceHomes.join(", ")}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              All threads in each selected project are imported. You can repeat an import to add
              newly created Codex threads.
            </p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy || importing} onClick={() => void load()}>
            Refresh
          </Button>
          <Button
            disabled={busy || importing || chosen.length === 0}
            onClick={() => void runImport()}
          >
            {importing
              ? "Importing…"
              : `Import ${chosen.length} ${chosen.length === 1 ? "project" : "projects"}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
