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

vi.mock("@/core/editor/document-session-registry", () => ({
  getLiveDocumentSessionRegistry: () => ({
    observeRetainedLiveDocuments: (observer: typeof rig.retainedObserver) => {
      rig.retainedObserver = observer;
      observer?.([]);
      return () => {
        rig.retainedObserver = null;
      };
    },
  }),
}));
vi.mock("@/client/query/project-context-availability", () => ({
  lookupProjectContextAvailability: vi.fn(),
}));

import {
  ContextRemovalAccountProvider,
  useProjectContextAvailabilityCoordinator,
} from "./ContextRemovalAccountProvider";
import type { ProjectContextAvailabilityCoordinator } from "./project-context-availability-coordinator";

describe("ContextRemovalAccountProvider retained producer", () => {
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
        <ContextRemovalAccountProvider accountId="account-1">
          <Capture />
        </ContextRemovalAccountProvider>
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
