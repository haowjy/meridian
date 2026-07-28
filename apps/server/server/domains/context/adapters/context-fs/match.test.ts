/** Grep match kernel: what a hit carries back, and what the count is a count of. */
import { describe, expect, it } from "vitest";
import { matchDocument } from "./match.js";

const HASHLINES = { hashlines: true };
const PLAIN = { hashlines: false };

describe("matchDocument", () => {
  it("carries the matched block's hash and counts every occurrence in the document", () => {
    const match = matchDocument(
      ["aa11|Elara waited.", "bb22|The hall was empty.", "cc33|Elara left, and Elara stayed."],
      "elara",
      HASHLINES,
    );
    expect(match).toEqual({
      excerpt: "aa11|Elara waited.",
      line: 1,
      blockHash: "aa11",
      matchCount: 3,
    });
  });

  it("never counts the hash itself", () => {
    // "cafe" is hex, so a hash can spell a query the writer's prose does not.
    expect(
      matchDocument(["cafe|nothing here", "beef|the cafe was closed"], "cafe", HASHLINES),
    ).toEqual({
      excerpt: "beef|the cafe was closed",
      line: 2,
      blockHash: "beef",
      matchCount: 1,
    });
  });

  it("reports the line a multi-line block starts on, not the line the match sits on", () => {
    const match = matchDocument(
      ["aa11|first block", "bb22|\n- one\n- needle\n- three", "cc33|last"],
      "needle",
      HASHLINES,
    );
    expect(match).toEqual({
      excerpt: "bb22|\n- one\n- needle\n- three",
      line: 2,
      blockHash: "bb22",
      matchCount: 1,
    });
  });

  it("omits the hash when a serialized block has none", () => {
    expect(matchDocument(["|unhashed body"], "unhashed", HASHLINES)).toEqual({
      excerpt: "|unhashed body",
      line: 1,
      matchCount: 1,
    });
  });

  it("treats plain markdown as lines and never splits a table row into a hash", () => {
    expect(matchDocument(["| name | role |", "| Elara | envoy |"], "elara", PLAIN)).toEqual({
      excerpt: "| Elara | envoy |",
      line: 2,
      matchCount: 1,
    });
  });

  it("returns null when nothing matches", () => {
    expect(matchDocument(["aa11|nothing"], "dragon", HASHLINES)).toBeNull();
    expect(matchDocument(["aa11|nothing"], "", HASHLINES)).toBeNull();
  });
});
