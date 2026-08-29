import type { CatalogEntry, CatalogScope } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { InMemoryContextCatalog } from "./in-memory-context-catalog";

const scope = { kind: "none", projectId: "project-1" } as const satisfies CatalogScope;
const source: CatalogEntry = {
  kind: "source",
  entryId: "source-1",
  scope,
  scheme: "uploads",
  name: "Uploads",
  uri: "uploads://@/",
};

describe("context catalog adapter contract", () => {
  it("replays only whole bounded commits", async () => {
    const catalog = new InMemoryContextCatalog();
    const before = await catalog.snapshot(scope);
    catalog.commit(scope, [
      { operation: "upsert", entry: source },
      { operation: "invalidate-subtree", rootEntryId: source.entryId },
    ]);
    const changes = await catalog.changes(scope, before.cursor, 1);
    expect(changes.kind).toBe("delta");
    if (changes.kind !== "delta") return;
    expect(changes.commits).toHaveLength(1);
    expect(changes.commits[0]?.changes).toHaveLength(2);
    expect(changes.nextCursor).not.toBe(before.cursor);
  });

  it("requires reset after replay pruning", async () => {
    const catalog = new InMemoryContextCatalog(1);
    const before = await catalog.snapshot(scope);
    catalog.commit(scope, [{ operation: "upsert", entry: source }]);
    catalog.commit(scope, [{ operation: "delete", entryId: source.entryId }]);
    await expect(catalog.changes(scope, before.cursor)).resolves.toMatchObject({
      kind: "reset-required",
      reason: "expired",
    });
  });

  it("supports direct children and stable ID/path lookup", async () => {
    const catalog = new InMemoryContextCatalog();
    catalog.commit(scope, [{ operation: "upsert", entry: source }]);
    await expect(catalog.lookup({ scope, entryId: source.entryId })).resolves.toMatchObject({
      entry: source,
    });
    await expect(catalog.lookup({ scope, uri: source.uri })).resolves.toMatchObject({
      entry: source,
    });
    await expect(catalog.children({ scope, parentId: source.entryId })).resolves.toMatchObject({
      entries: [],
    });
  });
});
