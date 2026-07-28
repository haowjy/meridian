/** Major-version compatibility tests for persisted collaboration heads. */
import { describe, expect, it } from "vitest";
import { isStaleSchema } from "./stale-schema.js";

describe("persisted collaboration schema compatibility", () => {
  it.each([
    [
      { major: 0, minor: 0, patch: 999 },
      { major: 0, minor: 1, patch: 0 },
    ],
    [
      { major: 0, minor: 2, patch: 0 },
      { major: 0, minor: 1, patch: 0 },
    ],
    [
      { major: 0, minor: 1, patch: 1 },
      { major: 0, minor: 1, patch: 0 },
    ],
  ])("accepts same-major heads in either direction", (stored, expected) => {
    expect(isStaleSchema(stored, expected)).toBe(false);
  });

  it.each([
    [
      { major: 0, minor: 1, patch: 0 },
      { major: 1, minor: 0, patch: 0 },
    ],
    [
      { major: 1, minor: 0, patch: 0 },
      { major: 0, minor: 1, patch: 0 },
    ],
  ])("rejects major mismatches in either direction", (stored, expected) => {
    expect(isStaleSchema(stored, expected)).toBe(true);
  });

  it("accepts an absent head", () => {
    expect(isStaleSchema(null, { major: 0, minor: 1, patch: 0 })).toBe(false);
  });
});
