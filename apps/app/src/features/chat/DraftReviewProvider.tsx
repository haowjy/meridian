/** Draft-review scope ownership and the boundary that exposes one scope to consumers. */

import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import {
  contextCatalogQueryOptions,
  contextCatalogScope,
  projectCatalogView,
} from "@/client/query/useContextCatalog";
import {
  type ThreadDraftGroup,
  type ThreadDraftsStatus,
  useWorkDrafts,
} from "@/client/query/useWorkDrafts";
import { useContextTabsStore } from "@/client/stores";
import type { DocumentSession } from "@/core/editor/document-session";
import {
  useContextRemovalCoordinator,
  useLiveDocumentSessionRegistry,
} from "@/features/project/context/ContextRemovalAccountProvider";
import { type DraftReviewController, useDraftReviewController } from "./useDraftReviewController";

export type DraftReviewContextValue = {
  controller: DraftReviewController;
  groups: ThreadDraftGroup[];
  drafts: ThreadDraftsStatus;
  groupForDocument: (documentId: string | null | undefined) => ThreadDraftGroup | null;
  reviewRoomNameForDraft: (documentId: string, draftId: string) => string | null;
  activeEditorDocumentId: string | null;
  setActiveEditorDocumentId: (
    documentId: string | null,
    session?: DocumentSession | null,
    inReview?: boolean,
    owner?: object,
  ) => void;
};

const DraftReviewContext = createContext<DraftReviewContextValue | null>(null);
let reviewProjectionOwnerSequence = 0;

export type DraftReviewProviderProps = {
  projectId: string | null;
  workId: string | null;
  /** Focused thread, when this review surface is thread-owned; threads cache invalidation. */
  threadId?: string | null;
  children: ReactNode;
};

export function DraftReviewProvider({
  projectId,
  workId,
  threadId = null,
  children,
}: DraftReviewProviderProps) {
  const value = useDraftReviewScopeValue({ projectId, workId, threadId });
  return <DraftReviewBoundary value={value}>{children}</DraftReviewBoundary>;
}

export function DraftReviewBoundary({
  value,
  children,
}: {
  value: DraftReviewContextValue;
  children: ReactNode;
}) {
  return <DraftReviewContext.Provider value={value}>{children}</DraftReviewContext.Provider>;
}

export function useDraftReviewScopeValue({
  projectId,
  workId,
  threadId = null,
}: Omit<DraftReviewProviderProps, "children">): DraftReviewContextValue {
  return useDraftReviewScopeOwner(projectId, workId, threadId);
}

function useDraftReviewScopeOwner(
  projectId: string | null,
  workId: string | null,
  threadId: string | null,
): DraftReviewContextValue {
  const queryClient = useQueryClient();
  const contextRemoval = useContextRemovalCoordinator();
  const registry = useLiveDocumentSessionRegistry();
  const reviewProjectionOwner = useRef(
    `draft-review-projection:${++reviewProjectionOwnerSequence}`,
  );
  const effectiveProjectId = projectId ?? "";
  const effectiveWorkId = workId ?? "";
  const drafts = useWorkDrafts(projectId, workId);
  const groups = drafts.groups ?? [];
  const controller = useDraftReviewController(effectiveProjectId, effectiveWorkId, threadId);
  // Editor-host concern: this only tells the chat overlay whether the active
  // editor already renders the docked bar for a document. Review-mode truth
  // itself lives in the controller state machine.
  const [activeEditorProjection, setActiveEditorProjection] = useState<{
    documentId: string;
    session: DocumentSession;
    inReview: boolean;
    owner: object | null;
  } | null>(null);
  const activeEditorDocumentId = activeEditorProjection?.documentId ?? null;
  const setActiveEditorDocumentId = useCallback(
    (
      documentId: string | null,
      session: DocumentSession | null = null,
      inReview = false,
      owner: object | null = null,
    ) => {
      setActiveEditorProjection((current) => {
        if (documentId && session) return { documentId, session, inReview, owner };
        return owner && current?.owner !== owner ? current : null;
      });
    },
    [],
  );

  useEffect(() => {
    controller.exitReview();
  }, [effectiveProjectId, effectiveWorkId, controller.exitReview]);

  const groupForDocument = useCallback(
    (documentId: string | null | undefined) => {
      if (!documentId) return null;
      return groups.find((group) => group.documentId === documentId) ?? null;
    },
    [groups],
  );

  const reviewRoomNameForDraft = useCallback(
    (documentId: string, draftId: string) =>
      controller.inlineReview?.documentId === documentId &&
      controller.inlineReview.draftId === draftId
        ? controller.reviewRoomName
        : null,
    [controller.inlineReview, controller.reviewRoomName],
  );

  useEffect(() => {
    const activeSelection = controller.inlineReview;
    if (activeSelection == null) return;
    if (drafts.status !== "ready" && drafts.status !== "empty") return;
    if (controller.isDisposing) return;
    if (controller.isServerAppliedAwaitingHost(activeSelection.documentId, activeSelection.draftId))
      return;
    const documentDrafts =
      groups.find((group) => group.documentId === activeSelection.documentId)?.drafts ?? [];
    if (documentDrafts.some((draft) => draft.draftId === activeSelection.draftId)) return;
    if (!projectId || !workId) {
      controller.exitReview();
      return;
    }
    const tabs = useContextTabsStore.getState();
    const tab = tabs.byProject[projectId]?.tabs.find(
      (candidate) => candidate.documentId === activeSelection.documentId,
    );
    if (tab?.kind !== "tracked" || !tab.draftOnly || tab.reviewWorkId !== workId) {
      controller.exitReview();
      return;
    }

    // The active-only list cannot say why a remote disposition removed the
    // draft. For draft-created documents, manifest membership is authoritative:
    // Apply materializes the document; Discard does not.
    const treeQuery = contextCatalogQueryOptions(
      queryClient,
      projectId,
      contextCatalogScope(projectId, "manuscript", null),
    );
    const attempt = new AbortController();
    void queryClient
      .cancelQueries({ queryKey: treeQuery.queryKey })
      .then(() => queryClient.fetchQuery({ ...treeQuery, staleTime: 0 }))
      .then((view) => {
        if (attempt.signal.aborted) return;
        const catalog = projectCatalogView(projectId, "manuscript", view);
        const currentTabs = useContextTabsStore.getState();
        const currentTab = currentTabs.byProject[projectId]?.tabs.find(
          (candidate) => candidate.documentId === activeSelection.documentId,
        );
        if (
          attempt.signal.aborted ||
          currentTab?.kind !== "tracked" ||
          !currentTab.draftOnly ||
          currentTab.reviewWorkId !== workId
        )
          return;
        const currentDrafts =
          queryClient.getQueryData<ThreadDraftListItem[]>(
            projectQueryKeys.workDrafts(projectId, workId),
          ) ?? [];
        if (currentDrafts.some((draft) => draft.documentId === activeSelection.documentId)) return;
        if (catalog.findDocument(activeSelection.documentId)) {
          if (
            controller.inlineReview?.documentId !== activeSelection.documentId ||
            controller.inlineReview.draftId !== activeSelection.draftId
          )
            return;
          return controller.acknowledgeServerApplied(
            activeSelection.documentId,
            activeSelection.draftId,
          );
        }
        controller.exitReview();
        void contextRemoval.discardDraft(projectId, workId, activeSelection.documentId);
      })
      // A failed membership check must leave the tab intact rather than guess
      // that a remotely applied document was discarded.
      .catch(() => undefined);
    return () => attempt.abort();
  }, [
    contextRemoval,
    controller.acknowledgeServerApplied,
    controller.exitReview,
    controller.inlineReview,
    controller.isServerAppliedAwaitingHost,
    controller.isDisposing,
    drafts.status,
    effectiveProjectId,
    groups,
    projectId,
    queryClient,
    registry,
    workId,
  ]);

  useEffect(() => {
    const inlineDocumentId = controller.inlineReview?.documentId;
    const inlineDraftId = controller.inlineReview?.draftId;
    const roomKey = controller.reviewRoomName;
    if (!projectId || !workId || !inlineDocumentId || !inlineDraftId || !roomKey) return;
    registry.retainBranchRooms(reviewProjectionOwner.current, [roomKey]);
    let session: DocumentSession;
    try {
      session = registry.getBranchRoom(roomKey);
    } catch (error) {
      registry.releaseBranchRooms(reviewProjectionOwner.current);
      throw error;
    }
    let timer: number | null = null;
    const invalidateMountedDraft = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({
          queryKey: projectQueryKeys.workDrafts(projectId, workId),
        });
        void queryClient.invalidateQueries({
          queryKey: projectQueryKeys.workDraftPreview(
            projectId,
            workId,
            inlineDocumentId,
            inlineDraftId,
          ),
        });
      }, 50);
    };
    session.document.on("update", invalidateMountedDraft);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      session.document.off("update", invalidateMountedDraft);
      registry.releaseBranchRooms(reviewProjectionOwner.current);
    };
  }, [
    controller.inlineReview?.documentId,
    controller.inlineReview?.draftId,
    controller.reviewRoomName,
    projectId,
    queryClient,
    workId,
  ]);

  useEffect(() => {
    if (!threadId || !activeEditorProjection || activeEditorProjection.inReview) return;
    const session = activeEditorProjection.session;
    let timer: number | null = null;
    const invalidateLineage = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({ queryKey: threadQueryKeys.liveLineageRoot(threadId) });
      }, 200);
    };
    session.document.on("update", invalidateLineage);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      session.document.off("update", invalidateLineage);
    };
  }, [activeEditorProjection, queryClient, threadId]);

  const value = useMemo<DraftReviewContextValue>(
    () => ({
      controller,
      groups,
      drafts,
      groupForDocument,
      reviewRoomNameForDraft,
      activeEditorDocumentId,
      setActiveEditorDocumentId,
    }),
    [controller, groups, drafts, groupForDocument, reviewRoomNameForDraft, activeEditorDocumentId],
  );

  return value;
}

export function useDraftReview(): DraftReviewContextValue {
  const value = useContext(DraftReviewContext);
  if (!value) {
    throw new Error("useDraftReview must be used within DraftReviewProvider");
  }
  return value;
}
