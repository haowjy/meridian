/** Project-lifetime bridge from authoritative catalog transitions to working-set owners. */

import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { CatalogCacheView } from "@/client/query/context-catalog-cache";
import { isProjectContextCatalogKey } from "@/client/query/project-query-keys";
import { observeWorksAvailability } from "@/client/query/works-availability-observer";
import { type ServerContextTab, useContextTabsStore } from "@/client/stores";
import { readRecentRoutes } from "@/client/working-set";
import {
  useContextRemovalCoordinator,
  useProjectContextAvailabilityCoordinator,
} from "./ContextRemovalAccountProvider";

function visibleFileIds(view: CatalogCacheView): Set<string> {
  return new Set(
    [...view.entries.values()].flatMap((entry) =>
      entry.kind === "file" && !view.invalidatedEntryIds.has(entry.entryId) ? [entry.entryId] : [],
    ),
  );
}

export function recentWatchedDocumentIds(
  recentRoutes: readonly WorkingSetRoute[],
  tabs: readonly ServerContextTab[],
): string[] {
  const identitiesByLocator = new Map(
    tabs.map((tab) => [`${tab.scheme}/${tab.workId ?? ""}/${tab.path}`, tab.documentId]),
  );
  return recentRoutes
    .slice(0, 64)
    .flatMap(
      (route) =>
        identitiesByLocator.get(`${route.scheme}/${route.workId ?? ""}/${route.path}`) ?? [],
    );
}

export function catalogWorkingSetTransition(
  previous: CatalogCacheView,
  next: CatalogCacheView,
  watchedDocumentIds: ReadonlySet<string> = new Set(),
): {
  vanishedDocumentIds: string[];
  changedWatchedDocumentIds: string[];
  unavailableWorkIds: string[];
} {
  const previousFiles = visibleFileIds(previous);
  const nextFiles = visibleFileIds(next);
  return {
    vanishedDocumentIds: [...previousFiles].filter((id) => !nextFiles.has(id)),
    changedWatchedDocumentIds: [...watchedDocumentIds].filter((documentId) => {
      const before = previous.entries.get(documentId);
      const after = next.entries.get(documentId);
      return Boolean(before && after && JSON.stringify(before) !== JSON.stringify(after));
    }),
    unavailableWorkIds: [...next.entries.values()].flatMap((entry) => {
      if (entry.kind !== "authority" || entry.authority.kind !== "work" || entry.available) {
        return [];
      }
      const before = previous.entries.get(entry.entryId);
      return before?.kind === "authority" && before.available ? [entry.authority.workId] : [];
    }),
  };
}

export function useCatalogWorkingSetReconciler(projectId: string): void {
  const queryClient = useQueryClient();
  const availability = useProjectContextAvailabilityCoordinator();
  const removal = useContextRemovalCoordinator();

  useEffect(() => {
    const lease = availability.attachProject(projectId, {
      onIndeterminate: () =>
        queryClient.invalidateQueries({ queryKey: ["projects", projectId, "context-catalog"] }),
    });
    let reportedWorkIds = new Set<string>();
    const reportWatches = () => {
      const slice = useContextTabsStore.getState().byProject[projectId];
      const tabs = (slice?.tabs ?? []).filter((tab) => tab.kind !== "new");
      lease.watch(
        "server-tabs",
        tabs.map((tab) => tab.documentId),
      );
      const nextWorkIds = new Set(tabs.flatMap((tab) => (tab.workId ? [tab.workId] : [])));
      for (const workId of reportedWorkIds) {
        if (!nextWorkIds.has(workId)) lease.watch(`work:${workId}`, []);
      }
      for (const workId of nextWorkIds) {
        lease.watch(
          `work:${workId}`,
          tabs.filter((tab) => tab.workId === workId).map((tab) => tab.documentId),
          { workId },
        );
      }
      reportedWorkIds = nextWorkIds;
      const selection = removal.getProjectSnapshot(projectId).selection;
      lease.watch(
        "route-selection",
        selection.status === "bound" && selection.identity.kind === "server"
          ? [selection.identity.documentId]
          : [],
        {
          ...(selection.status === "bound" && selection.locator.workId
            ? { workId: selection.locator.workId }
            : {}),
        },
      );
      lease.watch("recent-routes", recentWatchedDocumentIds(readRecentRoutes(projectId), tabs));
    };
    reportWatches();
    const stopTabs = useContextTabsStore.subscribe(reportWatches);
    const stopSelection = removal.subscribe(projectId, reportWatches);
    const stopWorksObservation = observeWorksAvailability(queryClient, projectId);
    const installed = new Map<string, CatalogCacheView>();
    for (const query of queryClient.getQueryCache().findAll()) {
      if (!isProjectContextCatalogKey(query.queryKey, projectId)) continue;
      const view = query.state.data as CatalogCacheView | undefined;
      if (view) installed.set(JSON.stringify(query.queryKey), view);
    }

    const stopWorkingSetObservation = queryClient.getQueryCache().subscribe((event) => {
      if (!isProjectContextCatalogKey(event.query.queryKey, projectId)) return;
      const next = event.query.state.data as CatalogCacheView | undefined;
      if (!next) return;
      const key = JSON.stringify(event.query.queryKey);
      const previous = installed.get(key);
      installed.set(key, next);
      if (!previous || previous === next) return;

      const transition = catalogWorkingSetTransition(
        previous,
        next,
        new Set(availability.watchedDocumentIds(projectId)),
      );
      void availability.observe({
        projectId,
        vanishedDocumentIds: transition.vanishedDocumentIds,
        changedWatchedDocumentIds: transition.changedWatchedDocumentIds,
      });
      for (const workId of transition.unavailableWorkIds) {
        void availability.coldScopeHint(projectId, workId);
      }
    });
    const repair = () => void availability.recheck(projectId);
    window.addEventListener("focus", repair);
    window.addEventListener("online", repair);
    const poll = window.setInterval(repair, 60_000);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener("focus", repair);
      window.removeEventListener("online", repair);
      stopTabs();
      stopSelection();
      stopWorksObservation();
      stopWorkingSetObservation();
      lease.release();
    };
  }, [availability, projectId, queryClient, removal]);
}
