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
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Modal, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LegendList } from "@legendapp/list/react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { agentSessions } from "../../state/agentSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

interface ImportWorkspace {
  readonly path: string;
  readonly title: string;
  readonly projectId?: ProjectId | undefined;
}

export function CodexImportSection() {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const group = projectGroups.find((entry) => entry.key === selectedProjectKey);
  const [target, setTarget] = useState<{
    environmentId: EnvironmentId;
    workspace: ImportWorkspace | null;
  } | null>(null);
  const targets = selectedTargets.flatMap((environment) => {
    const workspaces: readonly (ImportWorkspace | null)[] =
      selectedProjectKey === null
        ? [null]
        : (group?.members ?? [])
            .filter((member) => member.project.environmentId === environment.environmentId)
            .map(({ project }) => ({
              path: project.workspaceRoot,
              title: project.title,
              projectId: project.id,
            }));
    return workspaces.map((workspace) => ({ environment, workspace }));
  });
  if (targets.length === 0) return null;
  return (
    <SettingsSection title="Import projects">
      {targets.map(({ environment, workspace }) => (
        <View
          key={`${environment.environmentId}:${workspace?.projectId ?? "all"}`}
          className="gap-2 p-4"
        >
          <Text className="text-base font-t3-medium">Codex · {environment.label}</Text>
          <Text className="text-sm text-foreground-muted">
            {workspace?.path ??
              "Import Codex projects and their threads. Existing projects and threads are kept."}
          </Text>
          <ImportAction
            disabled={
              environment.serverConfig.environment?.capabilities.codexSessionImport !== true
            }
            onPress={() => setTarget({ environmentId: environment.environmentId, workspace })}
          >
            Import from Codex
          </ImportAction>
          {environment.serverConfig.environment?.capabilities.codexSessionImport !== true ? (
            <Text className="text-sm text-foreground-muted">
              Update this environment's T3 Code server to import Codex projects.
            </Text>
          ) : null}
        </View>
      ))}
      {target ? (
        <CodexImportModal
          key={`${target.environmentId}:${target.workspace?.path ?? "all"}`}
          environmentId={target.environmentId}
          workspace={target.workspace}
          onClose={() => setTarget(null)}
        />
      ) : null}
    </SettingsSection>
  );
}

function ImportAction({
  children,
  disabled = false,
  onPress,
}: {
  children: ReactNode;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={
        disabled
          ? "min-h-11 justify-center rounded-xl bg-subtle px-4 py-2 opacity-50"
          : "min-h-11 justify-center rounded-xl bg-subtle-strong px-4 py-2 active:opacity-70"
      }
    >
      <Text className="text-center text-sm font-t3-medium">{children}</Text>
    </Pressable>
  );
}

function CodexImportModal({
  environmentId,
  workspace,
  onClose,
}: {
  environmentId: EnvironmentId;
  workspace: ImportWorkspace | null;
  onClose: () => void;
}) {
  const scan = useAtomCommand(agentSessions.scanProjects, { reportFailure: false });
  const importProject = useAtomCommand(agentSessions.importCodex, { reportFailure: false });
  const [projects, setProjects] = useState<readonly AgentSessionProjectCandidate[]>([]);
  const [mode, setMode] = useState<CodexProjectImportMode>("selected");
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(workspace ? [workspace.path] : []),
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
        newProjectId: () => ProjectId.make(uuidv4()),
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
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => {
        if (!importing) onClose();
      }}
    >
      <SafeAreaView className="flex-1 bg-background">
        <View className="gap-3 px-5 pb-3 pt-4">
          <View className="flex-row items-center justify-between gap-3">
            <Text className="text-xl font-t3-semibold">Import projects from Codex</Text>
            <ImportAction disabled={importing} onPress={onClose}>
              Done
            </ImportAction>
          </View>
          <Text className="text-sm text-foreground-muted">
            Import projects with all their threads, including archived history. Existing T3 projects
            are reused and only missing threads are added.
          </Text>
          <View className="flex-row gap-2">
            {(["all", "selected"] as const).map((choice) => (
              <Pressable
                key={choice}
                accessibilityRole="radio"
                accessibilityState={{ checked: mode === choice, disabled: busy || importing }}
                disabled={busy || importing}
                onPress={() => setMode(choice)}
                className="min-h-11 flex-1 justify-center rounded-xl bg-card p-3"
              >
                <Text className="text-sm">
                  {mode === choice ? "◉" : "○"}{" "}
                  {choice === "all" ? "Import all projects" : "Select projects"}
                </Text>
              </Pressable>
            ))}
          </View>
          <AppTextInput
            accessibilityLabel="Search Codex projects"
            placeholder="Search projects…"
            value={query}
            onChangeText={setQuery}
            editable={!importing}
          />
          {error ? (
            <Text accessibilityRole="alert" className="text-sm text-destructive">
              {error}
            </Text>
          ) : null}
          {notice ? (
            <Text accessibilityLiveRegion="polite" className="text-sm">
              {notice}
            </Text>
          ) : null}
          {truncated ? (
            <Text className="text-sm text-foreground-muted">
              Discovery reached its scan limit. Only discovered projects and threads can be
              imported.
            </Text>
          ) : null}
        </View>
        <Text className="px-5 pb-2 text-xs text-foreground-muted">
          {projects.length} projects found ·{" "}
          {projects.filter((candidate) => candidate.unavailableReason !== undefined).length}{" "}
          unavailable
        </Text>
        <LegendList
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 16 }}
          keyboardShouldPersistTaps="handled"
          data={projects.filter((candidate) =>
            `${candidate.title} ${candidate.path}`.toLocaleLowerCase().includes(search),
          )}
          keyExtractor={(candidate) => candidate.path}
          extraData={{ selected, mode, busy, importing }}
          estimatedItemSize={110}
          recycleItems
          renderItem={({ item: candidate }) => {
            const checked =
              candidate.unavailableReason === undefined &&
              (mode === "all" || selected.has(candidate.path));
            const disabled =
              busy || importing || mode === "all" || candidate.unavailableReason !== undefined;
            return (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityLabel={`Import project ${candidate.title}`}
                accessibilityState={{ checked, disabled }}
                disabled={disabled}
                onPress={() =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(candidate.path)) next.delete(candidate.path);
                    else next.add(candidate.path);
                    return next;
                  })
                }
                className="mb-2 gap-1 rounded-xl bg-card p-4 active:opacity-70"
              >
                <Text className="text-base font-t3-medium">
                  {checked ? "☑" : "☐"} {candidate.title}
                </Text>
                <Text className="text-xs text-foreground-muted">{candidate.path}</Text>
                {candidate.unavailableReason ? (
                  <Text className="text-xs text-foreground-muted">
                    {candidate.unavailableReason}
                  </Text>
                ) : null}
                {candidate.unavailableReason === undefined ? (
                  <Text className="text-xs text-foreground-muted">
                    {candidate.threadCount} Codex threads ·{" "}
                    {candidate.projectId ? "Existing project — add missing threads" : "New project"}
                  </Text>
                ) : null}
              </Pressable>
            );
          }}
          ListEmptyComponent={
            !busy ? (
              <Text className="py-4 text-sm text-foreground-muted">
                No matching Codex projects found on this environment.
              </Text>
            ) : null
          }
        />
        <View className="gap-3 px-5 pb-4">
          {busy || progress ? (
            <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
              {progress ?? "Finding Codex projects…"}
            </Text>
          ) : null}
          {sourceHomes.length > 0 ? (
            <Text className="text-xs text-foreground-muted">
              Codex home: {sourceHomes.join(", ")}
            </Text>
          ) : null}
          <Text className="text-xs text-foreground-muted">
            All threads in each selected project are imported. You can repeat an import to add newly
            created Codex threads.
          </Text>
          <ImportAction disabled={busy || importing} onPress={() => void load()}>
            Refresh
          </ImportAction>
          <ImportAction
            disabled={busy || importing || chosen.length === 0}
            onPress={() => void runImport()}
          >
            {importing
              ? "Importing…"
              : `Import ${chosen.length} ${chosen.length === 1 ? "project" : "projects"}`}
          </ImportAction>
        </View>
      </SafeAreaView>
    </Modal>
  );
}
