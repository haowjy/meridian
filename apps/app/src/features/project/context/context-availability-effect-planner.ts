/** Pure final-state planner for one project's availability command batch. */
import {
  isWorkScopedProjectContextScheme,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";
import type { ContextTab, ProjectTabsSlice } from "@/client/stores";
import { buildWorkingSetRoute, workingSetRouteIdentityEquals } from "@/client/working-set";
import {
  type ContextRouteTarget,
  openContextRouteSearch,
  type ProjectSearch,
} from "../routing/project-route";
import type {
  AppliedAvailabilityCommand,
  ContextRemovalProjectSnapshot,
} from "./context-removal-coordinator";
import type { ContextRouteSelection } from "./context-removal-protocol";
import type { ProjectDocumentAvailabilityCommand } from "./project-context-availability-coordinator";

export type ContextAvailabilityLocalBatchPlan = Readonly<{
  projectId: string;
  commands: readonly ProjectDocumentAvailabilityCommand[];
  tabs: readonly ContextTab[];
  selectedTabIdByWork: Readonly<Record<string, string>>;
  selection: ContextRouteSelection;
  admitted: ContextRouteTarget | null;
  recentRoutes: readonly WorkingSetRoute[];
  routeSearch: ProjectSearch | null;
  generationRecords: readonly (AppliedAvailabilityCommand & { documentId: string })[];
  sessionEffects: readonly {
    commandId: string;
    operation: "revoke-document" | "revoke-access";
    projectId: string;
    documentId: string;
    generation: string;
  }[];
}>;

function documentId(command: ProjectDocumentAvailabilityCommand): string {
  return command.kind === "available" ? command.document.entryId : command.documentId;
}

function sameTarget(left: ContextRouteTarget | null, right: ContextRouteTarget): boolean {
  return left?.scheme === right.scheme && left.path === right.path && left.workId === right.workId;
}

export function planContextAvailabilityBatch(
  input: Readonly<{
    commands: readonly ProjectDocumentAvailabilityCommand[];
    project: ContextRemovalProjectSnapshot;
    tabs: ProjectTabsSlice;
    recentRoutes: readonly WorkingSetRoute[];
    routeSearch: ProjectSearch | null;
    appliedGenerations: ReadonlyMap<string, AppliedAvailabilityCommand>;
  }>,
): ContextAvailabilityLocalBatchPlan {
  const projectId = input.commands[0]?.projectId ?? "";
  let tabs = [...input.tabs.tabs];
  const selectedTabIdByWork = { ...input.tabs.selectedTabIdByWork };
  let selection = input.project.selection;
  let admitted = input.project.admitted;
  let recentRoutes = [...input.recentRoutes];
  let routeSearch = input.routeSearch;
  const generationRecords: Array<AppliedAvailabilityCommand & { documentId: string }> = [];
  const sessionEffects: ContextAvailabilityLocalBatchPlan["sessionEffects"][number][] = [];

  for (const command of input.commands) {
    const id = documentId(command);
    generationRecords.push({
      documentId: id,
      generation: command.generation,
      commandId: command.commandId,
      kind: command.kind,
    });
    if (command.kind === "available") {
      const entry = command.document;
      const scheme = entry.uri.slice(0, entry.uri.indexOf(":")) as ContextTab extends {
        scheme: infer Scheme;
      }
        ? Scheme
        : never;
      const path = entry.path.join("/");
      const targetWorkId = isWorkScopedProjectContextScheme(scheme)
        ? entry.scope.kind === "work"
          ? entry.scope.workId
          : null
        : input.project.activeWorkId;
      const target: ContextRouteTarget = { scheme, path, workId: targetWorkId };
      const priorTargets = tabs.flatMap((tab) =>
        tab.kind !== "new" && tab.documentId === id
          ? [
              {
                scheme: tab.scheme,
                path: tab.path,
                workId: isWorkScopedProjectContextScheme(tab.scheme)
                  ? (tab.workId ?? null)
                  : input.project.activeWorkId,
              } satisfies ContextRouteTarget,
            ]
          : [],
      );
      const selectedWorks = Object.entries(selectedTabIdByWork).flatMap(([workId, selected]) =>
        selected === id ? [workId] : [],
      );
      tabs = tabs.map((tab) => {
        if (tab.kind === "new" || tab.documentId !== id) return tab;
        const common = {
          ...tab,
          scheme,
          path,
          name: entry.name,
          provisionalName: entry.provisionalName,
        };
        if (isWorkScopedProjectContextScheme(scheme)) {
          if (targetWorkId) return { ...common, workId: targetWorkId } as ContextTab;
          const { workId: _oldWork, ...withoutWork } = common;
          return withoutWork as ContextTab;
        }
        const { workId: _oldWork, ...withoutWork } = common;
        return targetWorkId
          ? ({ ...withoutWork, workId: targetWorkId } as ContextTab)
          : withoutWork;
      });
      for (const workId of selectedWorks) delete selectedTabIdByWork[workId];
      if (targetWorkId && selectedWorks.length > 0) selectedTabIdByWork[targetWorkId] = id;
      if (
        selection.status === "bound" &&
        selection.identity.kind === "server" &&
        selection.identity.documentId === id
      ) {
        const previous = selection.locator;
        selection = { ...selection, locator: target };
        admitted = target;
        if (
          routeSearch?.screen === "context" &&
          routeSearch.scheme === previous.scheme &&
          routeSearch.path === previous.path &&
          (routeSearch.work ?? null) === previous.workId
        ) {
          routeSearch = openContextRouteSearch(routeSearch, target);
        }
      } else if (priorTargets.some((prior) => sameTarget(admitted, prior))) {
        admitted = target;
      }
      const replacement = buildWorkingSetRoute(
        id,
        scheme,
        path,
        isWorkScopedProjectContextScheme(scheme) ? targetWorkId : undefined,
      );
      if (replacement) {
        recentRoutes = recentRoutes.map((route) =>
          workingSetRouteIdentityEquals(route, replacement) ? replacement : route,
        );
      }
      continue;
    }

    const removable = new Set(
      tabs.flatMap((tab) =>
        tab.kind !== "new" && !tab.draftOnly && tab.documentId === id ? [tab.documentId] : [],
      ),
    );
    tabs = tabs.filter((tab) => !removable.has(tab.documentId));
    for (const [workId, selected] of Object.entries(selectedTabIdByWork)) {
      if (selected === id) delete selectedTabIdByWork[workId];
    }
    recentRoutes = recentRoutes.filter((route) => route.documentId !== id);
    if (
      selection.status === "bound" &&
      selection.identity.kind === "server" &&
      selection.identity.documentId === id
    ) {
      admitted = null;
    }
    sessionEffects.push({
      commandId: command.commandId,
      operation: command.kind === "terminal-remove" ? "revoke-document" : "revoke-access",
      projectId,
      documentId: id,
      generation: command.generation,
    });
  }

  return {
    projectId,
    commands: input.commands,
    tabs,
    selectedTabIdByWork,
    selection,
    admitted,
    recentRoutes,
    routeSearch,
    generationRecords,
    sessionEffects,
  };
}
