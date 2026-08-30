/** Bridges background untitled reconciliation receipts into the open-tab store. */
import { useEffect, useRef } from "react";
import { type ContextTab, useContextTabsActions, useContextTabsStore } from "@/client/stores";
import type { LiveDocumentBinding } from "./open-project-document";
import {
  isUntitledPending,
  registerUntitledCandidate,
  syncUntitledReceiptOwners,
} from "./untitled-reconciler-browser";

export function useUntitledTabBridge({
  projectId,
  tabs,
}: {
  projectId: string;
  tabs: ContextTab[];
}): void {
  const { remintNewTab, materializeNewTab, updateTrackedTab } = useContextTabsActions();
  const adoptedBindings = useRef(new Map<string, LiveDocumentBinding>());

  useEffect(() => {
    const present = new Set(tabs.map((tab) => tab.documentId));
    for (const [documentId, binding] of adoptedBindings.current) {
      if (present.has(documentId)) continue;
      binding.release();
      adoptedBindings.current.delete(documentId);
    }
  }, [tabs]);

  useEffect(
    () => () => {
      for (const binding of adoptedBindings.current.values()) binding.release();
      adoptedBindings.current.clear();
    },
    [],
  );

  useEffect(() => {
    syncUntitledReceiptOwners();
    const cleanups = tabs
      .filter(
        (tab) =>
          tab.kind === "new" ||
          (tab.kind === "tracked" &&
            tab.provisionalName &&
            isUntitledPending(projectId, tab.documentId)),
      )
      .map((tab) =>
        registerUntitledCandidate(projectId, tab.documentId, {
          onReminted: (documentId) => remintNewTab(projectId, tab.documentId, documentId),
          onMaterialized: ({ result, identity, binding }) => {
            const slice = useContextTabsStore.getState().byProject[projectId];
            if (!slice?.tabs.some((candidate) => candidate.documentId === tab.documentId)) {
              binding?.release();
              return;
            }
            if (binding) {
              adoptedBindings.current.get(tab.documentId)?.release();
              adoptedBindings.current.set(tab.documentId, binding);
            }
            materializeNewTab(projectId, tab.documentId, {
              kind: "tracked",
              documentId: tab.documentId,
              scheme: result.scheme,
              path: result.path,
              name: result.name,
              workId: result.workId ?? undefined,
              editable: true,
              filetype: "markdown",
              schemaType: "document",
              provisionalName: true,
            });
            if (identity) {
              updateTrackedTab(projectId, tab.documentId, {
                scheme: identity.scheme,
                path: identity.path,
                name: identity.name,
                workId: identity.workId,
                provisionalName: false,
              });
            }
          },
        }),
      );
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [materializeNewTab, projectId, remintNewTab, tabs, updateTrackedTab]);
}
