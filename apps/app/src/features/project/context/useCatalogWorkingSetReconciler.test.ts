/** Catalog transition evidence for working-set convergence. */
import type { CatalogEntry, CatalogScope } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { catalogViewFromSnapshot } from "@/client/query/context-catalog-cache";
import { catalogWorkAuthorityChanged } from "@/client/query/works-availability-observer";
import { catalogWorkingSetTransition } from "./useCatalogWorkingSetReconciler";

const scope = { kind: "project", projectId: "project-1" } as const satisfies CatalogScope;
const file = (entryId: string, path: string): CatalogEntry => ({
  kind: "file",
  entryId,
  scope,
  sourceId: "source-1",
  parentId: "source-1",
  name: path,
  aliases: [],
  path: [path],
  uri: `manuscript://${path}` as never,
  editable: true,
  filetype: "markdown",
  schemaType: "document",
  provisionalName: false,
});
const work = (available: boolean, entityRevision = "1"): CatalogEntry => ({
  kind: "authority",
  entryId: "work-1" as never,
  scope,
  authority: { kind: "work", workId: "work-1" as never, workSlug: "draft" as never },
  name: "Draft",
  available,
  entityRevision,
});
const view = (entries: CatalogEntry[]) =>
  catalogViewFromSnapshot({
    scope,
    generation: "generation-1",
    headRevision: "1",
    cursor: "cursor-1",
    entries,
  });

describe("catalog working-set transition", () => {
  it("treats reset omission as authoritative disappearance", () => {
    expect(catalogWorkingSetTransition(view([file("document-1", "Old.md")]), view([]))).toEqual({
      vanishedDocumentIds: ["document-1"],
      unavailableWorkIds: [],
    });
  });

  it("preserves same-ID moves in the final installed view", () => {
    expect(
      catalogWorkingSetTransition(
        view([file("document-1", "Old.md")]),
        view([file("document-1", "New.md")]),
      ).vanishedDocumentIds,
    ).toEqual([]);
  });

  it("reports an available Work becoming unavailable without treating restore as removal", () => {
    expect(catalogWorkingSetTransition(view([work(true)]), view([work(false)]))).toEqual({
      vanishedDocumentIds: [],
      unavailableWorkIds: ["work-1"],
    });
    expect(catalogWorkingSetTransition(view([work(false)]), view([work(true)]))).toEqual({
      vanishedDocumentIds: [],
      unavailableWorkIds: [],
    });
  });

  it("requests canonical convergence for both lifecycle directions and entity-only changes", () => {
    expect(catalogWorkAuthorityChanged(view([work(true)]), view([work(false, "2")]))).toBe(true);
    expect(catalogWorkAuthorityChanged(view([work(false, "2")]), view([work(true, "3")]))).toBe(
      true,
    );
    expect(catalogWorkAuthorityChanged(view([work(true, "3")]), view([work(true, "4")]))).toBe(
      true,
    );
    expect(catalogWorkAuthorityChanged(view([work(true, "4")]), view([work(true, "4")]))).toBe(
      false,
    );
  });
});
