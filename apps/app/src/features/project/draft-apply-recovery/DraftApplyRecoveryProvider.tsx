/** Reactive authenticated-account projection for post-Apply disposition data. */

import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import { useAccountPostApplyDispositionOwner } from "../context/ContextRemovalAccountProvider";
import type { PostApplyDispositionOwner, PostApplySnapshot } from "./draft-apply-recovery-owner";

const PostApplyDispositionContext = createContext<{
  accountId: string;
  owner: PostApplyDispositionOwner;
} | null>(null);

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
