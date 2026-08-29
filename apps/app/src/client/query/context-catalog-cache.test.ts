import type { CatalogEntry, CatalogScope } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { ContextCatalogCache, catalogChildren, catalogFiles } from "./context-catalog-cache";

const scope = { kind: "project", projectId: "project-1" } as const satisfies CatalogScope;
const source: CatalogEntry = {
  kind: "source",
  entryId: "source-1",
  scope,
  scheme: "manuscript",
  name: "Manuscript",
  uri: "manuscript://" as never,
};
const folder: CatalogEntry = {
  kind: "folder",
  entryId: "folder-1",
  scope,
  sourceId: "source-1",
  parentId: "source-1",
  name: "Arc",
  path: ["Arc"],
  uri: "manuscript://Arc" as never,
  hasChildren: true,
};
const file: CatalogEntry = {
  kind: "file",
  entryId: "document-1",
  scope,
  sourceId: "source-1",
  parentId: "folder-1",
  name: "Chapter.md",
  aliases: [],
  path: ["Arc", "Chapter.md"],
  uri: "manuscript://Arc/Chapter.md" as never,
  fileType: "markdown",
  provisionalName: false,
};

describe("ContextCatalogCache", () => {
  it("normalizes one identity for tree and picker projections", () => {
    const cache = new ContextCatalogCache();
    const view = cache.replace({
      scope,
      generation: "generation-1",
      headRevision: "1",
      cursor: "cursor-1",
      entries: [source, folder, file],
    });
    expect(catalogChildren(view, "folder-1")[0]).toBe(catalogFiles(view)[0]);
  });

  it("applies whole commits idempotently and invalidates a subtree immediately", () => {
    const cache = new ContextCatalogCache();
    cache.replace({
      scope,
      generation: "generation-1",
      headRevision: "1",
      cursor: "cursor-1",
      entries: [source, folder, file],
    });
    const delta = {
      kind: "delta" as const,
      scope,
      commits: [
        {
          eventId: "event-2",
          commitId: "commit-2",
          firstRevision: "2",
          lastRevision: "2",
          changes: [
            { operation: "invalidate-subtree" as const, ordinal: 0, rootEntryId: "folder-1" },
          ],
        },
      ],
      nextCursor: "cursor-2",
      headRevision: "2",
      hasMore: false,
    };
    const first = cache.apply(delta);
    const duplicate = cache.apply(delta);
    expect(first && catalogFiles(first)).toEqual([]);
    expect(duplicate?.entries.size).toBe(3);
    expect(duplicate?.cursor).toBe("cursor-2");
  });

  it("requests snapshot replacement on reset without mutating live state", () => {
    const cache = new ContextCatalogCache();
    const before = cache.replace({
      scope,
      generation: "generation-1",
      headRevision: "1",
      cursor: "cursor-1",
      entries: [source],
    });
    expect(cache.apply({ kind: "reset-required", scope, reason: "expired" })).toBeNull();
    expect(cache.read(scope)).toBe(before);
  });
});
