/** Project-lifetime bridge from authoritative catalog transitions to working-set owners. */
import type { CatalogEntry } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { CatalogCacheView } from "@/client/query/context-catalog-cache";
import { isProjectContextCatalogKey } from "@/client/query/project-query-keys";
import { useContextTabsStore } from "@/client/stores";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { useContextRemovalCoordinator } from "./ContextRemovalAccountProvider";

function visibleFileIds(view: CatalogCacheView): Set<string> {
  return new Set(
    [...view.entries.values()].flatMap((entry) =>
      entry.kind === "file" && !view.invalidatedEntryIds.has(entry.entryId) ? [entry.entryId] : [],
    ),
  );
}

function unavailableWorkIds(previous: CatalogCacheView, next: CatalogCacheView): string[] {
  const availableBefore = new Set(
    [...previous.entries.values()].flatMap((entry) =>
      entry.kind === "authority" && entry.authority.kind === "work" && entry.available
        ? [entry.authority.workId]
        : [],
    ),
  );
  return [...next.entries.values()].flatMap((entry: CatalogEntry) =>
    entry.kind === "authority" &&
    entry.authority.kind === "work" &&
    !entry.available &&
    availableBefore.has(entry.authority.workId)
      ? [entry.authority.workId]
      : [],
  );
}

export function catalogWorkingSetTransition(
  previous: CatalogCacheView,
  next: CatalogCacheView,
): { vanishedDocumentIds: string[]; unavailableWorkIds: string[] } {
  const nextFiles = visibleFileIds(next);
  return {
    vanishedDocumentIds: [...visibleFileIds(previous)].filter((id) => !nextFiles.has(id)),
    unavailableWorkIds: unavailableWorkIds(previous, next),
  };
}

export function useCatalogWorkingSetReconciler(projectId: string): void {
  const queryClient = useQueryClient();
  const removal = useContextRemovalCoordinator();

  useEffect(() => {
    const installed = new Map<string, CatalogCacheView>();
    for (const query of queryClient.getQueryCache().findAll()) {
      if (!isProjectContextCatalogKey(query.queryKey, projectId)) continue;
      const view = query.state.data as CatalogCacheView | undefined;
      if (view) installed.set(JSON.stringify(query.queryKey), view);
    }

    return queryClient.getQueryCache().subscribe((event) => {
      if (!isProjectContextCatalogKey(event.query.queryKey, projectId)) return;
      const next = event.query.state.data as CatalogCacheView | undefined;
      if (!next) return;
      const key = JSON.stringify(event.query.queryKey);
      const previous = installed.get(key);
      installed.set(key, next);
      if (!previous || previous === next) return;

      const transition = catalogWorkingSetTransition(previous, next);
      const documentIds = [...transition.vanishedDocumentIds];
      if (documentIds.length > 0) removal.catalogUnavailable(projectId, documentIds);
      const sessions = getDocumentSessionRegistry();
      for (const documentId of documentIds) {
        void sessions.revokeRoom(documentId, { clearPersistence: true });
      }
      for (const unavailableWorkId of transition.unavailableWorkIds) {
        const unavailableDocumentIds: string[] = [];
        const slice = useContextTabsStore.getState().byProject[projectId];
        for (const tab of slice?.tabs ?? []) {
          if (tab.kind !== "new" && tab.workId === unavailableWorkId) {
            unavailableDocumentIds.push(tab.documentId);
          }
        }
        const selection = removal.getProjectSnapshot(projectId).selection;
        if (
          selection.status === "bound" &&
          selection.identity.kind === "server" &&
          selection.locator.workId === unavailableWorkId
        ) {
          unavailableDocumentIds.push(selection.identity.documentId);
        }
        const uniqueDocumentIds = [...new Set(unavailableDocumentIds)];
        removal.workUnavailable(projectId, unavailableWorkId, uniqueDocumentIds);
        for (const documentId of uniqueDocumentIds) {
          void sessions.revokeRoom(documentId, { clearPersistence: true });
        }
      }
    });
  }, [projectId, queryClient, removal]);
}
