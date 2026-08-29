import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { catalogViewFromSnapshot } from "./context-catalog-cache";
import { projectQueryKeys } from "./project-query-keys";
import { pullContextCatalogOnHint } from "./useContextCatalog";

describe("catalog hint receiver", () => {
  it("invalidates React Query acquisition only when the hinted head is newer", () => {
    const scope = { kind: "project" as const, projectId: "project-1" };
    const queryKey = projectQueryKeys.contextCatalog("project-1", scope);
    const view = catalogViewFromSnapshot({
      scope,
      generation: "generation-1",
      headRevision: "2",
      cursor: "cursor-2",
      entries: [],
    });
    const invalidateQueries = vi.fn();
    const queryClient = {
      getQueryData: () => view,
      invalidateQueries,
    } as unknown as QueryClient;

    pullContextCatalogOnHint(queryClient, "project-1", {
      type: "context-catalog-hint",
      scope,
      headRevision: "2",
    });
    expect(invalidateQueries).not.toHaveBeenCalled();

    pullContextCatalogOnHint(queryClient, "project-1", {
      type: "context-catalog-hint",
      scope,
      headRevision: "3",
    });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey });
  });
});
