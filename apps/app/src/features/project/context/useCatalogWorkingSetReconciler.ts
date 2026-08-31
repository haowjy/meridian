/** Project-lifetime bridge from authoritative catalog transitions to working-set owners. */

import {
  isWorkScopedProjectContextScheme,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { CatalogCacheView } from "@/client/query/context-catalog-cache";
import { isProjectContextCatalogKey } from "@/client/query/project-query-keys";
import { observeWorksAvailability } from "@/client/query/works-availability-observer";
import { useContextTabsStore } from "@/client/stores";
import type { ContextTab } from "@/client/stores/context-tabs-store/context-tabs-store";
import { readRecentRoutes } from "@/client/working-set";
import {
  useContextRemovalCoordinator,
  useProjectContextAvailabilityCoordinator,
} from "./account-feature-context";
import type { AvailabilityWatchRecord } from "./project-context-availability-coordinator";

function routeWatchRecord(route: WorkingSetRoute): AvailabilityWatchRecord {
  return {
    documentId: route.documentId,
    ...(isWorkScopedProjectContextScheme(route.scheme) && route.workId
      ? { sourceWorkId: route.workId }
      : {}),
  };
}

function tabWatchRecord(tab: Exclude<ContextTab, { kind: "new" }>): AvailabilityWatchRecord {
  return {
    documentId: tab.documentId,
    ...(isWorkScopedProjectContextScheme(tab.scheme) && tab.workId
      ? { sourceWorkId: tab.workId }
      : {}),
  };
}

function visibleFileIds(view: CatalogCacheView): Set<string> {
  return new Set(
    [...view.entries.values()].flatMap((entry) =>
      entry.kind === "file" && !view.invalidatedEntryIds.has(entry.entryId) ? [entry.entryId] : [],
    ),
  );
}

export function recentWatchedDocumentIds(recentRoutes: readonly WorkingSetRoute[]): string[] {
  return recentRoutes.slice(0, 64).map((route) => route.documentId);
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
    const lease = availability.attachProject(projectId);
    const reportWatches = () => {
      const slice = useContextTabsStore.getState().byProject[projectId];
      const tabs = (slice?.tabs ?? []).filter((tab) => tab.kind !== "new");
      lease.watch("server-tabs", tabs.map(tabWatchRecord));
      const selection = removal.getProjectSnapshot(projectId).selection;
      lease.watch(
        "route-selection",
        selection.status === "bound" && selection.identity.kind === "server"
          ? [
              {
                documentId: selection.identity.documentId,
                ...(isWorkScopedProjectContextScheme(selection.locator.scheme) &&
                selection.locator.workId
                  ? { sourceWorkId: selection.locator.workId }
                  : {}),
              },
            ]
          : [],
      );
      lease.watch("recent-routes", readRecentRoutes(projectId).slice(0, 64).map(routeWatchRecord));
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
    return () => {
      stopTabs();
      stopSelection();
      stopWorksObservation();
      stopWorkingSetObservation();
      lease.release();
    };
  }, [availability, projectId, queryClient, removal]);
}
