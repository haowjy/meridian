import type { CatalogEntry, CatalogScope } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { ContextCatalogCache } from "@/client/query/context-catalog-cache";
import { projectCatalogTree } from "@/client/query/useContextCatalog";
import { catalogFileSuggestions } from "./file-suggestions";

const scope = { kind: "project", projectId: "project-1" } as const satisfies CatalogScope;
const entries: CatalogEntry[] = [
  {
    kind: "source",
    entryId: "source-1",
    scope,
    scheme: "manuscript",
    name: "Manuscript",
    uri: "manuscript://",
  },
  {
    kind: "file",
    entryId: "document-1",
    scope,
    sourceId: "source-1",
    parentId: "source-1",
    name: "Chapter.md",
    aliases: [],
    path: ["Chapter.md"],
    uri: "manuscript://Chapter.md",
    fileType: "markdown",
    provisionalName: false,
  },
];

describe("catalog projections", () => {
  it("projects tree and picker from the same normalized identity", () => {
    const view = new ContextCatalogCache().replace({
      scope,
      generation: "generation-1",
      headRevision: "0",
      cursor: "cursor-0",
      entries,
    });
    const tree = projectCatalogTree(scope.projectId, "manuscript", view).tree;
    const picker = catalogFileSuggestions([view]);
    expect(tree.children[0]).toMatchObject({ documentId: "document-1", path: "/Chapter.md" });
    expect(picker).toContainEqual(
      expect.objectContaining({ scheme: "manuscript", path: "/Chapter.md", kind: "file" }),
    );
    expect(view.entries.get("document-1")).toBe(entries[1]);
  });
});
