/** Executor edge-consumption proofs for terminal context settlement. */
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  AccountPostApplyDispositionOwner,
  type DraftRecoveryRef,
  type PostApplyDispositionOwner,
} from "./draft-apply-recovery-owner";

let owner: PostApplyDispositionOwner;
const settle = vi.fn();
const open = vi.fn();
const acknowledge = vi.fn();

vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ setQueryData() {} }) }));
vi.mock("../context/ContextRemovalAccountProvider", () => ({
  useContextRemovalCoordinator: () => ({ settleDraftRecovery: settle }),
  useProjectDocumentLiveOpener: () => ({ open }),
}));
vi.mock("../dock/editor-review-handoff", () => ({
  useAcknowledgeLiveBinding: () => acknowledge,
}));
vi.mock("./DraftApplyRecoveryProvider", async () => {
  const React = await import("react");
  return {
    usePostApplyDispositionOwner: () => owner,
    usePostApplySnapshot: () =>
      React.useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot),
    useOptionalPostApplyDisposition: () => ({ accountId: "account-a", owner }),
  };
});

const { ProjectDraftApplyRecoveryExecutor, useProjectDraftApplyRecovery } = await import(
  "./ProjectDraftApplyRecoveryExecutor"
);

function disposingOwner(): { value: PostApplyDispositionOwner; recovery: DraftRecoveryRef } {
  const value = new AccountPostApplyDispositionOwner("account-a", {
    replaceExactRoomNames() {},
  });
  const identity = {
    accountId: "account-a",
    projectId: "project-a",
    workId: "work-a",
    documentId: "document-a",
    draftId: "draft-a",
  };
  const reserved = value.reserveApply({
    identity,
    presentation: {
      documentName: "Chapter",
      contextPath: "chapter.md",
      owningWorkLabel: "Work A",
    },
    obligations: {
      draftTab: {
        kind: "draft-only",
        reviewWorkId: "work-a",
        reviewDraftId: "draft-a",
        tabInstanceToken: "tab-a",
      },
      branch: { kind: "generation-qualified", reviewRoomName: "branch:abc:gen:1" },
    },
  });
  if (reserved.kind !== "reserved") throw new Error("reserve");
  const acquired = value.acquireApplyDispatch(reserved.unsent);
  if (acquired.kind !== "dispatch-granted") throw new Error("dispatch");
  const recorded = value.recordServerApplied({
    kind: "local-response",
    dispatch: acquired.dispatch,
    responseDraftId: "draft-a",
  });
  if (recorded.kind !== "recorded") throw new Error("record");
  const attempt = value.beginAttempt(recorded.recovery);
  if (!attempt) throw new Error("attempt");
  if (!value.beginLiveSettlement(attempt)) throw new Error("disposition");
  return { value, recovery: recorded.recovery };
}

function Commands({
  capture,
}: {
  capture: (value: ReturnType<typeof useProjectDraftApplyRecovery>) => void;
}) {
  capture(useProjectDraftApplyRecovery());
  return null;
}

async function proveQuiescent(failure: "stale" | "throw") {
  const fixture = disposingOwner();
  owner = fixture.value;
  settle.mockReset();
  if (failure === "stale") settle.mockReturnValue({ kind: "stale-obligation" });
  else
    settle.mockImplementation(() => {
      throw new Error("persistent fault");
    });
  let commands: ReturnType<typeof useProjectDraftApplyRecovery> | null = null;
  await withReactRoot(
    <ProjectDraftApplyRecoveryExecutor
      projectId="project-a"
      scopeKey="work-a"
      mobileContextPath={null}
      inlineDocumentIds={[]}
      desktopHostDocumentIds={[]}
      workLabels={{}}
    >
      <Commands capture={(value) => (commands = value)} />
    </ProjectDraftApplyRecoveryExecutor>,
    async () => {
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)));
      expect(settle).toHaveBeenCalledOnce();
      expect(owner.currentItem(fixture.recovery)?.phase.kind).toBe("disposing");
      act(() => commands?.finishDisposition(fixture.recovery));
      expect(settle).toHaveBeenCalledTimes(2);
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)));
      expect(settle).toHaveBeenCalledTimes(2);
    },
    { drainMacrotask: true },
  );
}

describe("ProjectDraftApplyRecoveryExecutor terminal settlement", () => {
  it("quiesces a stale terminal receipt until exact Finish", () => proveQuiescent("stale"));
  it("quiesces a thrown terminal effect until exact Finish", () => proveQuiescent("throw"));

  it("executor remount retries one pending terminal obligation", async () => {
    const fixture = disposingOwner();
    owner = fixture.value;
    settle.mockReset().mockReturnValue({ kind: "stale-obligation" });
    const executor = (
      <ProjectDraftApplyRecoveryExecutor
        projectId="project-a"
        scopeKey="work-a"
        mobileContextPath={null}
        inlineDocumentIds={[]}
        desktopHostDocumentIds={[]}
        workLabels={{}}
      >
        <div />
      </ProjectDraftApplyRecoveryExecutor>
    );
    await withReactRoot(executor, async () => {
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)));
      expect(settle).toHaveBeenCalledOnce();
    });
    await withReactRoot(executor, async () => {
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)));
      expect(settle).toHaveBeenCalledTimes(2);
    });
  });
});
