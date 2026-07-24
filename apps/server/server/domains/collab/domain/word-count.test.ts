import { describe, expect, it } from "vitest";
import { countWords, wordDeltaBetweenTexts } from "./word-count.js";

describe("word counting", () => {
  it("uses whitespace-delimited words", () => {
    expect(countWords("  Ashes\n of\t the Vale  ")).toBe(4);
    expect(countWords(" \n ")).toBe(0);
  });

  it("counts only inserted and deleted payloads for an edit", () => {
    expect(wordDeltaBetweenTexts("The old gate opened.", "The jade gate opened slowly.")).toEqual({
      wordsAdded: 2,
      wordsRemoved: 1,
    });
  });
});
