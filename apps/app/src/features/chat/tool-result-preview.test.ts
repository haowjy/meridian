import { describe, expect, it, vi } from "vitest";

import {
  boundLabel,
  matchCountLabel,
  normalizeListing,
  normalizeSearchHits,
  searchBoundLabel,
} from "./tool-result-preview";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((copy, part, index) => copy + part + (values[index] ?? ""), ""),
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));

describe("the caller picks the parser", () => {
  it("reads every listing entry, even after one that looks like a search hit", () => {
    // Shape-sniffing classified a whole array from its first recognizable
    // entry, so one odd row upstream discarded every valid row behind it.
    const rows = normalizeListing([
      { uri: "manuscript://stray.md", excerpt: "not a listing field" },
      { uri: "manuscript://arc-one", kind: "directory" },
      { uri: "manuscript://chapter-1.md", kind: "file" },
    ]);

    expect(rows.rows).toEqual([
      { kind: "folder", uri: "manuscript://arc-one" },
      { kind: "document", uri: "manuscript://chapter-1.md" },
    ]);
    expect(rows.total).toBe(3);
  });

  it("reads every search hit, even after one that looks like a listing entry", () => {
    const rows = normalizeSearchHits(
      [
        { uri: "manuscript://arc-one", kind: "directory" },
        { uri: "manuscript://chapter-2.md", excerpt: "79b9|The hollow gate stood." },
      ],
      "gate",
    );

    expect(rows.rows).toEqual([
      {
        kind: "document",
        uri: "manuscript://chapter-2.md",
        excerpt: { lead: "The hollow ", match: "gate", trail: " stood.", clipped: false },
      },
    ]);
    expect(rows.total).toBe(2);
  });

  it("never reads a listing as search hits, whatever the entries look like", () => {
    // A listing entry has no passage, so reading it as a hit yields nothing —
    // which is the point: the tool decides, not the payload.
    expect(normalizeSearchHits([{ uri: "manuscript://chapter-1.md", kind: "file" }]).rows).toEqual(
      [],
    );
  });

  it("skips malformed entries without stopping at them", () => {
    const rows = normalizeListing([
      null,
      "not an object",
      { kind: "file" },
      { uri: "manuscript://chapter-1.md", kind: "file" },
    ]);

    expect(rows.rows).toEqual([{ kind: "document", uri: "manuscript://chapter-1.md" }]);
    // The bound reports the payload's size, not what we could parse.
    expect(rows.total).toBe(4);
  });

  it("returns nothing for a payload that is not a list at all", () => {
    expect(normalizeListing({ results: [] }).rows).toEqual([]);
    expect(normalizeSearchHits(undefined).rows).toEqual([]);
  });
});

describe("caps and bounds", () => {
  const listing = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      uri: `manuscript://chapter-${index + 1}.md`,
      kind: "file",
    }));

  it("stops a listing at eight and states the rest", () => {
    const rows = normalizeListing(listing(23));

    expect(rows.rows).toHaveLength(8);
    expect(boundLabel(rows)).toBe("8 of 23");
  });

  it("stops search hits at four, because each one is three lines", () => {
    const hits = Array.from({ length: 42 }, (_, index) => ({
      uri: `manuscript://chapter-${index + 1}.md`,
      excerpt: "The hollow gate stood.",
    }));

    expect(normalizeSearchHits(hits).rows).toHaveLength(4);
    expect(boundLabel(normalizeSearchHits(hits))).toBe("4 of 42");
  });

  it("states no bound when nothing was cut", () => {
    expect(boundLabel(normalizeListing(listing(3)))).toBeNull();
  });
});

describe("what a search says it found", () => {
  const hit = (index: number, matchCount: number) => ({
    uri: `manuscript://chapter-${index}.md`,
    excerpt: `79b9|Elara waited.`,
    blockHash: "79b9",
    matchCount,
  });

  it("carries the hash and the term the door needs, and never the hash on screen", () => {
    const rows = normalizeSearchHits([hit(1, 5)], "elara");

    expect(rows.rows[0]).toEqual({
      kind: "document",
      uri: "manuscript://chapter-1.md",
      excerpt: { lead: "", match: "Elara", trail: " waited.", clipped: false },
      passage: { blockHash: "79b9", term: "elara" },
      matchCount: 5,
    });
  });

  it("leaves a hit with no hash as a plain document door", () => {
    const rows = normalizeSearchHits(
      [{ uri: "kb://elara.md", excerpt: "A scout from the Vale.", matchCount: 2 }],
      "scout",
    );

    expect(rows.rows[0]).not.toHaveProperty("passage");
  });

  it("counts results across the whole payload, not just the rows that fit", () => {
    const hits = Array.from({ length: 6 }, (_, index) => hit(index + 1, 2));

    expect(searchBoundLabel(normalizeSearchHits(hits, "elara"))).toBe("12 results in 6 documents");
  });

  it("falls back to the cut fact while results and documents say the same thing", () => {
    const hits = Array.from({ length: 42 }, (_, index) => hit(index + 1, 1));

    expect(searchBoundLabel(normalizeSearchHits(hits, "elara"))).toBe("4 of 42");
  });

  it("states no total when any hit declines to count", () => {
    const hits = [hit(1, 3), { uri: "kb://elara.md", excerpt: "A scout." }];

    expect(searchBoundLabel(normalizeSearchHits(hits, "elara"))).toBeNull();
  });

  it("says how many matches a row stands for, and stays quiet at one", () => {
    expect(matchCountLabel(5)).toBe("5 matches");
    expect(matchCountLabel(1)).toBeNull();
    expect(matchCountLabel(undefined)).toBeNull();
  });
});
