/** Stable-ID-only availability HTTP body contract. */
import { describe, expect, it } from "vitest";
import { parseAvailabilityBody } from "./availability.post.js";

function id(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

describe("availability route body", () => {
  it("deduplicates and accepts 128 IDs", () => {
    const documentIds = Array.from({ length: 128 }, (_, index) => id(index));
    expect(
      parseAvailabilityBody(id(999), { documentIds: [...documentIds, documentIds[0]] }).documentIds,
    ).toEqual(documentIds);
  });

  it("rejects 129 IDs and non-ID lookup inputs", () => {
    expect(() =>
      parseAvailabilityBody(id(999), {
        documentIds: Array.from({ length: 129 }, (_, index) => id(index)),
      }),
    ).toThrow(/at most 128/);
    expect(() => parseAvailabilityBody(id(999), { paths: ["chapter.md"] })).toThrow(/documentIds/);
  });
});
