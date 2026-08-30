/**
 * useDraftReviewController — shared state machine for reviewing AI document drafts.
 *
 * The dock Changes cards and editor header both address the same inline review
 * session; this controller keeps whole-draft apply/discard, selective
 * per-card Discard, review closure, and editor focus state on one path so
 * review surfaces cannot drift. Apply commits the whole current branch.
 */

import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { getDraftPreview } from "@/client/api/drafts-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useApplyDraft, useDiscardDraft } from "@/client/query/useDraftReviewMutations";
import { useContextTabsStore } from "@/client/stores";
import {
  useContextRemovalCoordinator,
  useProjectDocumentLiveOpener,
} from "@/features/project/context/ContextRemovalAccountProvider";
import { useAcknowledgeLiveBinding } from "@/features/project/dock/editor-review-handoff";
import {
  type DraftBatchErrorCode,
  type DraftCommandOutcome,
  type DraftReviewCommandPorts,
  type DraftReviewSelection,
  DraftReviewSession,
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
  type InlineDraftReview,
  type InlineReviewMessage,
  type InlineReviewMessageCode,
  inlineReviewFromState,
} from "./draft-review-session";

export type { DraftReviewSelection, InlineDraftReview, InlineReviewMessageCode };

type QualifiedDraftSelection = DraftReviewSelection & { projectId: string; workId: string };

/**
 * The single review-runtime claim: the mounted editor a review card can scroll
 * to, plus the selection it is showing. Dispositions do NOT read it — they take
 * their selection from review state so the Changes rail works on screens with no
 * manuscript pane. Registration is claim-based on the editor identity
 * (see register/release below).
 */
export type InlineReviewRuntime = {
  editor: Editor;
  documentId: string;
  draftId: string;
};

export type DraftReviewController = {
  projectId: string;
  workId: string;
  /** Focused thread owning this review surface; threads Apply/Discard cache invalidation. */
  threadId: string | null;
  inlineReview: InlineDraftReview | null;
  reviewRoomName: string | null;
  reviewRoomError: boolean;
  isApplying: boolean;
  isDiscarding: boolean;
  isPending: boolean;
  isInlineDiscardPending: boolean;
  canApplyReviewedDraft: boolean;
  /**
   * The global disposition lock: any Apply/Discard in flight in the session.
   * Every mutating control disables on it so dispositions can't overlap.
   */
  isDisposing: boolean;
  pendingInlineDiscardIds: (draftId: string | null | undefined) => ReadonlySet<string>;
  inlineReviewMessage: InlineReviewMessage | null;
  inlineDiscardError: InlineReviewMessageCode | null;
  dockDispositionError: DraftBatchErrorCode | null;
  enterInlineReview: (documentId: string, draftId: string) => void;
  exitInlineReview: () => void;
  exitReview: () => void;
  inlineReviewModelAvailable: (identity: string, documentId: string, draftId: string) => void;
  /**
   * Claim/release the single review-runtime slot. Registration is claim-based:
   * only the editor that holds the claim can release it. This matters because
   * the context host keeps warm HIDDEN editors mounted — an unconditional
   * "clear on not-in-review" from any of them would stomp the active review
   * editor's registration (found live: card clicks silently no-oped after
   * switching review documents).
   */
  registerInlineReviewRuntime: (runtime: InlineReviewRuntime) => void;
  releaseInlineReviewRuntime: (editor: Editor) => void;
  /**
   * Highlight and scroll the reviewed document to an operation's span. Reads
   * the review editor off the runtime so any surface (the dock Changes cards)
   * can drive the manuscript without holding the editor handle itself.
   */
  focusReviewOperation: (operationId: string) => void;
  discardOperation: (operationId: string) => Promise<DraftCommandOutcome>;
  apply: (documentId: string, draftId: string) => Promise<DraftCommandOutcome>;
  acknowledgeServerApplied: (documentId: string, draftId: string) => Promise<DraftCommandOutcome>;
  isServerAppliedAwaitingHost: (documentId: string, draftId: string) => boolean;
  discard: (documentId: string, draftId: string) => Promise<DraftCommandOutcome>;
  disposeDrafts: (
    mode: "apply" | "discard",
    drafts: readonly DraftReviewSelection[],
  ) => Promise<DraftCommandOutcome[]>;
};

export function useDraftReviewController(
  projectId: string,
  workId: string,
  threadId: string | null = null,
): DraftReviewController {
  const queryClient = useQueryClient();
  const contextRemoval = useContextRemovalCoordinator();
  const liveOpener = useProjectDocumentLiveOpener();
  const acknowledgeLiveBinding = useAcknowledgeLiveBinding();
  const applyMutation = useApplyDraft();
  const discardMutation = useDiscardDraft();
  const [state, dispatch] = useReducer(draftReviewReducer, EMPTY_DRAFT_REVIEW_STATE);
  const commandPortsRef = useRef<DraftReviewCommandPorts | null>(null);
  const serverAppliedRef = useRef<QualifiedDraftSelection | null>(null);
  const applyAttemptRef = useRef<{
    selection: QualifiedDraftSelection;
    generation: number;
    abort: AbortController;
  } | null>(null);
  const nextApplyAttemptRef = useRef(0);
  const reviewSession = useMemo(
    () =>
      new DraftReviewSession(() => {
        const ports = commandPortsRef.current;
        if (!ports) throw new Error("Draft review command ports are not ready.");
        return ports;
      }),
    [],
  );
  const dispositionLock = reviewSession.disposition;
  const disposition = useSyncExternalStore(
    dispositionLock.subscribe,
    dispositionLock.getSnapshot,
    dispositionLock.getSnapshot,
  );
  const [reviewRoomName, setReviewRoomName] = useState<string | null>(null);
  const [reviewRoomError, setReviewRoomError] = useState(false);
  const stateRef = useRef(state);
  const activeRef = useRef(true);
  const inlineRuntimeRef = useRef<InlineReviewRuntime | null>(null);
  const activeReviewRequestRef = useRef<(DraftReviewSelection & { attemptId: number }) | null>(
    null,
  );
  const nextReviewAttemptIdRef = useRef(0);
  stateRef.current = state;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      applyAttemptRef.current?.abort.abort();
      applyAttemptRef.current = null;
      serverAppliedRef.current = null;
    };
  }, []);

  const inlineReview = inlineReviewFromState(state);
  const inlineReviewMessage = state.inlineReviewMessage;
  const inlineDiscardError = state.inlineDiscardError;
  const dockDispositionError = state.dockDispositionError;

  const activeDisposition = disposition.busy ? disposition.target : null;
  const isApplying = activeDisposition?.kind === "apply-draft";
  const isDiscarding = activeDisposition?.kind === "discard-draft";
  const isInlineDiscardPending = activeDisposition?.kind === "discard-operation";
  const isPending = isApplying || isDiscarding;
  const isDisposing = disposition.busy;
  const canApplyReviewedDraft =
    state.surface.kind === "inline" && state.surface.previewIdentity !== undefined;
  const pendingInlineDiscardIds = useCallback(
    (draftId: string | null | undefined): ReadonlySet<string> =>
      activeDisposition?.kind === "discard-operation" && activeDisposition.draftId === draftId
        ? new Set([activeDisposition.operationId])
        : EMPTY_OPERATION_IDS,
    [activeDisposition],
  );

  useEffect(() => {
    if (inlineReview) return;
    activeReviewRequestRef.current = null;
    setReviewRoomName(null);
    setReviewRoomError(false);
  }, [inlineReview]);

  const loadInlineReviewRoom = useCallback(
    (documentId: string, draftId: string) => {
      nextReviewAttemptIdRef.current += 1;
      const attemptId = nextReviewAttemptIdRef.current;
      activeReviewRequestRef.current = { documentId, draftId, attemptId };
      setReviewRoomName(null);
      setReviewRoomError(false);
      void getDraftPreview(projectId, workId, documentId, draftId)
        .then((preview) => {
          queryClient.setQueryData(
            projectQueryKeys.workDraftPreview(projectId, workId, documentId, draftId),
            preview,
          );
          const current = activeReviewRequestRef.current;
          if (
            current?.documentId !== documentId ||
            current.draftId !== draftId ||
            current.attemptId !== attemptId
          )
            return;
          if (preview.status === "active") setReviewRoomName(preview.reviewRoomName);
        })
        .catch(() => {
          const current = activeReviewRequestRef.current;
          if (
            current?.documentId !== documentId ||
            current.draftId !== draftId ||
            current.attemptId !== attemptId
          )
            return;
          void queryClient.invalidateQueries({
            queryKey: projectQueryKeys.workDraftPreview(projectId, workId, documentId, draftId),
          });
          setReviewRoomName(null);
          setReviewRoomError(true);
        });
    },
    [projectId, queryClient, workId],
  );

  commandPortsRef.current = {
    apply: async ({ documentId, draftId }) => {
      const selection = { projectId, workId, documentId, draftId };
      const initialSurface = stateRef.current.surface;
      const requiresInlineMatch =
        initialSurface.kind === "inline" &&
        initialSurface.documentId === documentId &&
        initialSurface.draftId === draftId;
      const selectionIsCurrent = () =>
        activeRef.current &&
        (!requiresInlineMatch ||
          (stateRef.current.surface.kind === "inline" &&
            stateRef.current.surface.documentId === documentId &&
            stateRef.current.surface.draftId === draftId));
      if (!sameQualifiedSelection(serverAppliedRef.current, selection)) {
        await applyMutation.mutateAsync({
          projectId,
          workId,
          threadId,
          documentId,
          draftId,
        });
        if (!selectionIsCurrent()) throw new Error("Applied draft selection changed");
        serverAppliedRef.current = selection;
      }
      const generation = ++nextApplyAttemptRef.current;
      applyAttemptRef.current?.abort.abort();
      const abort = new AbortController();
      applyAttemptRef.current = { selection, generation, abort };
      const opened = await liveOpener.open({
        source: "server",
        projectId,
        documentId,
        signal: abort.signal,
      });
      if (opened.kind !== "opened") throw new Error("Applied draft is not available live");
      if (
        !selectionIsCurrent() ||
        !currentApplyAttempt(applyAttemptRef.current, selection, generation)
      ) {
        throw new Error("Applied draft selection changed");
      }

      const tab = useContextTabsStore
        .getState()
        .byProject?.[projectId]?.tabs.find((candidate) => candidate.documentId === documentId);
      const inline = stateRef.current.surface;
      const desiredHost =
        tab?.kind === "tracked" ||
        (inline.kind === "inline" &&
          inline.documentId === documentId &&
          inline.draftId === draftId);
      if (desiredHost) {
        const acknowledged = await acknowledgeLiveBinding(opened.admission, abort.signal);
        if (acknowledged.kind !== "acknowledged") {
          throw new Error("Applied draft host did not acknowledge the live binding");
        }
      } else {
        const binding = await opened.admission.bind(
          `draft-apply-verification:${projectId}:${workId}:${documentId}:${generation}`,
        );
        try {
          await binding.session.waitForCurrentSync(10_000);
          const snapshot = binding.session.getSnapshot();
          if (snapshot.status !== "synced" || snapshot.schemaFence !== null) {
            throw new Error("Applied draft verification binding is unusable");
          }
        } finally {
          binding.release();
        }
      }
      if (
        !selectionIsCurrent() ||
        !currentApplyAttempt(applyAttemptRef.current, selection, generation)
      ) {
        throw new Error("Applied draft acknowledgement became stale");
      }
    },
    discard: async ({ documentId, draftId }, input) => {
      await discardMutation.mutateAsync({
        projectId,
        workId,
        threadId,
        documentId,
        draftId,
        ...input,
      });
    },
    operationDiscardStarted: () => {
      dispatch({ type: "discardStarted" });
    },
    batchStarted: () => {
      dispatch({ type: "batchStarted" });
    },
    batchSettled: (error) => {
      dispatch({ type: "batchSettled", error });
    },
    draftApplied: ({ documentId, draftId }) => {
      const selection = { projectId, workId, documentId, draftId };
      if (!sameQualifiedSelection(serverAppliedRef.current, selection)) return;
      dispatch({ type: "applySucceeded", documentId, draftId });
      contextRemoval.applyDraftMetadata(projectId, workId, documentId);
      applyAttemptRef.current?.abort.abort();
      applyAttemptRef.current = null;
      serverAppliedRef.current = null;
    },
    draftFailed: (selection, code) => {
      dispatch({ type: "draftCommandFailed", selection, code });
    },
    draftDiscarded: ({ documentId, draftId }) => {
      dispatch({ type: "discardSucceeded", draftId });
      void contextRemoval.discardDraft(projectId, workId, documentId);
    },
  };

  const enterInlineReview = useCallback(
    (documentId: string, draftId: string) => {
      const pending = serverAppliedRef.current;
      if (pending && (pending.documentId !== documentId || pending.draftId !== draftId)) {
        applyAttemptRef.current?.abort.abort();
        applyAttemptRef.current = null;
        serverAppliedRef.current = null;
      }
      dispatch({ type: "enterInline", documentId, draftId });
      loadInlineReviewRoom(documentId, draftId);
    },
    [loadInlineReviewRoom],
  );

  const exitInlineReview = useCallback(() => {
    const inline = stateRef.current.surface.kind === "inline" ? stateRef.current.surface : null;
    if (inline) {
      if (
        serverAppliedRef.current?.documentId === inline.documentId &&
        serverAppliedRef.current.draftId === inline.draftId
      ) {
        applyAttemptRef.current?.abort.abort();
        applyAttemptRef.current = null;
        serverAppliedRef.current = null;
      }
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.workDraftPreview(
          projectId,
          workId,
          inline.documentId,
          inline.draftId,
        ),
      });
    }
    activeReviewRequestRef.current = null;
    setReviewRoomName(null);
    setReviewRoomError(false);
    dispatch({ type: "exitInline" });
  }, [projectId, queryClient, workId]);

  const exitReview = useCallback(() => {
    applyAttemptRef.current?.abort.abort();
    applyAttemptRef.current = null;
    serverAppliedRef.current = null;
    activeReviewRequestRef.current = null;
    setReviewRoomName(null);
    setReviewRoomError(false);
    dispatch({ type: "exitReview" });
  }, []);

  const inlineReviewModelAvailable = useCallback(
    (identity: string, documentId: string, draftId: string) => {
      dispatch({ type: "inlineModelAvailable", identity, documentId, draftId });
    },
    [],
  );

  const registerInlineReviewRuntime = useCallback((runtime: InlineReviewRuntime) => {
    inlineRuntimeRef.current = runtime;
  }, []);

  // Release is a no-op unless the caller still holds the claim: on a review
  // document switch the new editor may register before the old one's effect
  // cleanup runs, and that stale cleanup must not clear the fresh claim.
  const releaseInlineReviewRuntime = useCallback((editor: Editor) => {
    if (inlineRuntimeRef.current?.editor === editor) {
      inlineRuntimeRef.current = null;
    }
  }, []);

  const focusReviewOperation = useCallback((operationId: string) => {
    const editor = inlineRuntimeRef.current?.editor;
    if (!editor || editor.isDestroyed) return;
    editor.commands.setInlineReviewActiveOperation(operationId);
    editor.commands.scrollInlineReviewOperationIntoView(operationId);
  }, []);

  const discardOperation = useCallback(
    async (operationId: string): Promise<DraftCommandOutcome> => {
      // The review selection comes from state, not from the editor runtime:
      // the disposition is server-backed, so a Changes card must work on
      // screens where the manuscript is not mounted.
      const current = stateRef.current;
      const inline = current.surface.kind === "inline" ? current.surface : null;
      if (!inline) return { kind: "failed", code: "discard-failed" };
      const outcome = await reviewSession.discardOperation(inline, operationId);
      if (outcome.kind === "failed") {
        dispatch({
          type: "discardFailed",
          code: outcome.code,
        });
      }
      return outcome;
    },
    [reviewSession],
  );

  const apply = useCallback(
    (documentId: string, draftId: string): Promise<DraftCommandOutcome> =>
      reviewSession.applyReviewedDraft({ documentId, draftId }),
    [reviewSession],
  );

  const acknowledgeServerApplied = useCallback(
    (documentId: string, draftId: string): Promise<DraftCommandOutcome> => {
      serverAppliedRef.current = { projectId, workId, documentId, draftId };
      return reviewSession.applyReviewedDraft({ documentId, draftId });
    },
    [projectId, reviewSession, workId],
  );
  const isServerAppliedAwaitingHost = useCallback(
    (documentId: string, draftId: string) =>
      sameQualifiedSelection(serverAppliedRef.current, {
        projectId,
        workId,
        documentId,
        draftId,
      }),
    [projectId, workId],
  );

  const discard = useCallback(
    (documentId: string, draftId: string): Promise<DraftCommandOutcome> =>
      reviewSession.discardDraft({ documentId, draftId }),
    [reviewSession],
  );

  const disposeDrafts = useCallback(
    (
      mode: "apply" | "discard",
      drafts: readonly DraftReviewSelection[],
    ): Promise<DraftCommandOutcome[]> => reviewSession.disposeDrafts(mode, drafts),
    [reviewSession],
  );

  return useMemo(
    () => ({
      projectId,
      workId,
      threadId,
      inlineReview,
      reviewRoomName,
      reviewRoomError,
      isApplying,
      isDiscarding,
      isPending,
      isInlineDiscardPending,
      canApplyReviewedDraft,
      isDisposing,
      pendingInlineDiscardIds,
      inlineReviewMessage,
      inlineDiscardError,
      dockDispositionError,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      inlineReviewModelAvailable,
      registerInlineReviewRuntime,
      releaseInlineReviewRuntime,
      focusReviewOperation,
      discardOperation,
      apply,
      acknowledgeServerApplied,
      isServerAppliedAwaitingHost,
      discard,
      disposeDrafts,
    }),
    [
      projectId,
      workId,
      threadId,
      inlineReview,
      reviewRoomName,
      reviewRoomError,
      isApplying,
      isDiscarding,
      isPending,
      isInlineDiscardPending,
      canApplyReviewedDraft,
      isDisposing,
      pendingInlineDiscardIds,
      inlineReviewMessage,
      inlineDiscardError,
      dockDispositionError,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      inlineReviewModelAvailable,
      registerInlineReviewRuntime,
      releaseInlineReviewRuntime,
      focusReviewOperation,
      discardOperation,
      apply,
      acknowledgeServerApplied,
      isServerAppliedAwaitingHost,
      discard,
      disposeDrafts,
    ],
  );
}

const EMPTY_OPERATION_IDS = new Set<string>();

function sameQualifiedSelection(
  left: QualifiedDraftSelection | null,
  right: QualifiedDraftSelection,
): boolean {
  return (
    left?.projectId === right.projectId &&
    left.workId === right.workId &&
    left.documentId === right.documentId &&
    left.draftId === right.draftId
  );
}

function currentApplyAttempt(
  current: {
    selection: QualifiedDraftSelection;
    generation: number;
    abort: AbortController;
  } | null,
  selection: QualifiedDraftSelection,
  generation: number,
): boolean {
  return (
    current?.generation === generation &&
    !current.abort.signal.aborted &&
    sameQualifiedSelection(current.selection, selection)
  );
}
