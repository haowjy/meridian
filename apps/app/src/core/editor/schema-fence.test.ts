/** Schema-fence quarantine validation and blocked-storage tolerance. */

import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readSchemaFenceQuarantine, writeSchemaFenceQuarantine } from "./schema-fence";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("schema-fence quarantine", () => {
  it("round-trips the reachable fence", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const fence = { reason: "client-superseded" } as const;

    expect(writeSchemaFenceQuarantine("document-1", fence)).toBe(true);
    expect(readSchemaFenceQuarantine("document-1")).toEqual(fence);
  });

  it("rejects unknown reasons", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);

    storage.setItem(
      `meridian:schema-fence:v${COLLAB_SCHEMA_VERSION}:unknown`,
      JSON.stringify({ reason: "repair-detected" }),
    );

    expect(readSchemaFenceQuarantine("unknown")).toBeNull();
  });

  it("never throws when storage access is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });

    expect(readSchemaFenceQuarantine("document-1")).toBeNull();
    expect(writeSchemaFenceQuarantine("document-1", { reason: "client-superseded" })).toBe(false);
  });
});
