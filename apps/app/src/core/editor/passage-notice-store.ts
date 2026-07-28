/**
 * The honest end of a search-match door: when the promised passage cannot be
 * found in the live document, the document still opens and the writer is told
 * why they are not where the row said they would be.
 *
 * A door that silently lands at the top of a chapter is the failure this
 * exists to prevent — the writer would read the wrong paragraph believing it
 * was the one they searched for. One notice at a time, keyed by document, so a
 * later jump replaces an earlier one rather than stacking.
 *
 * Client-only module singleton, like the announcement store: nothing here is
 * SSR-rendered, so no per-request isolation is needed.
 */
import { create } from "zustand";

type PassageNoticeStore = {
  /** The document currently showing a stale-passage notice, if any. */
  documentId: string | null;
  /** Serial of the current notice, so a repeat jump restarts its dismissal. */
  raisedAt: number;
  reportPassageChanged: (documentId: string) => void;
  dismissPassageNotice: () => void;
};

const usePassageNoticeStore = create<PassageNoticeStore>((set) => ({
  documentId: null,
  raisedAt: 0,
  reportPassageChanged: (documentId) => set({ documentId, raisedAt: Date.now() }),
  dismissPassageNotice: () => set({ documentId: null, raisedAt: 0 }),
}));

/** Say that a jump into this document could not find the passage it promised. */
export function reportPassageChanged(documentId: string): void {
  usePassageNoticeStore.getState().reportPassageChanged(documentId);
}

export function dismissPassageNotice(): void {
  usePassageNoticeStore.getState().dismissPassageNotice();
}

/** `null` when this document has nothing to say; otherwise the notice's serial. */
export function usePassageNotice(documentId: string | null): number | null {
  return usePassageNoticeStore((state) =>
    documentId !== null && state.documentId === documentId ? state.raisedAt : null,
  );
}
