// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";

const rig = vi.hoisted(() => ({
  retainedObserver: null as
    | null
    | ((snapshot: readonly { projectId: string; documentId: string }[]) => void),
}));

vi.mock("@/core/editor/account-document-session-runtime", () => ({
  createAccountDocumentSessionRuntime: ({ accountId }: { accountId: string }) => ({
    accountId,
    epochSignal: new AbortController().signal,
    registry: {
      observeRetainedLiveDocuments: (observer: typeof rig.retainedObserver) => {
        rig.retainedObserver = observer;
        observer?.([]);
        return () => {
          rig.retainedObserver = null;
        };
      },
    },
    localLifetime: { tryAcquire: async () => null },
    localConstruction: { createDetached: vi.fn() },
    localReservation: { reserve: vi.fn() },
    localAdoption: { admitAndAdopt: vi.fn() },
    beginClose: vi.fn(),
    finishClose: vi.fn(async () => undefined),
  }),
}));
vi.mock("@/client/query/project-context-availability", () => ({
  lookupProjectContextAvailability: vi.fn(),
}));

import {
  AccountFeatureTestProvider,
  useProjectContextAvailabilityCoordinator,
} from "@/test-support/account-feature-provider";
import type { ProjectContextAvailabilityCoordinator } from "./project-context-availability-coordinator";

describe("AccountFeatureTestProvider retained producer", () => {
  it("keeps a detached retained-only project watched without a project view", async () => {
    let availability: ProjectContextAvailabilityCoordinator | null = null;
    function Capture() {
      const value = useProjectContextAvailabilityCoordinator();
      useLayoutEffect(() => {
        availability = value;
      }, [value]);
      return null;
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await withReactRoot(
      <QueryClientProvider client={queryClient}>
        <AccountFeatureTestProvider accountId="account-1">
          <Capture />
        </AccountFeatureTestProvider>
      </QueryClientProvider>,
      async () => {
        rig.retainedObserver?.([{ projectId: "project-retained", documentId: "document-only" }]);
        expect(availability?.watchedDocumentIds("project-retained")).toEqual(["document-only"]);
        rig.retainedObserver?.([]);
        expect(availability?.watchedDocumentIds("project-retained")).toEqual([]);
      },
    );
  });
});
