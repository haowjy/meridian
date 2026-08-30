/** Reactive authenticated-account projection for post-Apply disposition data. */

import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { useAccountPostApplyDispositionOwner } from "../context/ContextRemovalAccountProvider";
import type { PostApplyDispositionOwner, PostApplySnapshot } from "./draft-apply-recovery-owner";

const PostApplyDispositionContext = createContext<{
  accountId: string;
  owner: PostApplyDispositionOwner;
} | null>(null);
const EMPTY_SNAPSHOT: PostApplySnapshot = {
  nextVersion: 1,
  reservations: [],
  items: [],
  appliedSuppressions: [],
  remoteDraftWitnesses: [],
};

export function DraftApplyRecoveryProvider({
  accountId,
  children,
}: {
  accountId: string;
  children: ReactNode;
}) {
  const owner = useAccountPostApplyDispositionOwner();
  return (
    <PostApplyDispositionContext.Provider value={{ accountId, owner }}>
      {children}
    </PostApplyDispositionContext.Provider>
  );
}

export function usePostApplyDispositionOwner(): PostApplyDispositionOwner {
  const value = useContext(PostApplyDispositionContext);
  if (!value) throw new Error("DraftApplyRecoveryProvider is required");
  return value.owner;
}

export function usePostApplyAccountId(): string {
  const value = useContext(PostApplyDispositionContext);
  if (!value) throw new Error("DraftApplyRecoveryProvider is required");
  return value.accountId;
}

export function usePostApplySnapshot(): PostApplySnapshot {
  const owner = usePostApplyDispositionOwner();
  return useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
}

export function useOptionalPostApplyDisposition(): {
  accountId: string;
  owner: PostApplyDispositionOwner;
} | null {
  return useContext(PostApplyDispositionContext);
}

export function usePostApplyCommandGroups(
  groups: readonly ThreadDraftGroup[] | null,
  projectId: string,
  workId: string,
): ThreadDraftGroup[] | null {
  const disposition = useOptionalPostApplyDisposition();
  const snapshot = useSyncExternalStore(
    disposition?.owner.subscribe ?? (() => () => undefined),
    disposition?.owner.getSnapshot ?? (() => EMPTY_SNAPSHOT),
    disposition?.owner.getSnapshot ?? (() => EMPTY_SNAPSHOT),
  );
  if (!groups) return null;
  return groups.flatMap((group) => {
    const visible = group.drafts.filter((draft) => {
      const matches = (identity: {
        accountId: string;
        projectId: string;
        workId: string;
        documentId: string;
        draftId: string;
      }) =>
        identity.accountId === disposition?.accountId &&
        identity.projectId === projectId &&
        identity.workId === workId &&
        identity.documentId === draft.documentId &&
        identity.draftId === draft.draftId;
      return !(
        snapshot.reservations.some((item) => matches(item.identity)) ||
        snapshot.items.some((item) => matches(item.identity)) ||
        snapshot.appliedSuppressions.some((item) => matches(item.identity))
      );
    });
    return visible.length > 0 ? [{ ...group, drafts: visible }] : [];
  });
}
