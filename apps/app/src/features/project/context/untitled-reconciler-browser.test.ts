/** Browser untitled recovery reads the complete catalog before choosing a Work. */
import { describe, expect, it } from "vitest";
import { resolveUntitledCatalogHome } from "./untitled-reconciler-browser";

describe("resolveUntitledCatalogHome", () => {
  it("uses explicit no-Work authority without selecting a catalog Work", async () => {
    await expect(resolveUntitledCatalogHome("project")).resolves.toBeNull();
  });
});
