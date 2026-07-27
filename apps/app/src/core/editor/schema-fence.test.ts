/** Schema-fence quarantine validation and blocked-storage tolerance. */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearSchemaFenceQuarantine,
  readSchemaFenceQuarantine,
  schemaFenceQuarantineKey,
  writeSchemaFenceQuarantine,
} from "./schema-fence";

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
  it("round-trips valid fences and clears them", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const fence = { reason: "invalid-content", detail: "unsupported node" } as const;

    expect(writeSchemaFenceQuarantine("document-1", fence)).toBe(true);
    expect(readSchemaFenceQuarantine("document-1")).toEqual(fence);

    clearSchemaFenceQuarantine("document-1");
    expect(readSchemaFenceQuarantine("document-1")).toBeNull();
  });

  it("rejects unknown reasons and malformed detail", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);

    storage.setItem(schemaFenceQuarantineKey("unknown"), JSON.stringify({ reason: "stale-head" }));
    storage.setItem(
      schemaFenceQuarantineKey("bad-detail"),
      JSON.stringify({ reason: "repair-detected", detail: 42 }),
    );

    expect(readSchemaFenceQuarantine("unknown")).toBeNull();
    expect(readSchemaFenceQuarantine("bad-detail")).toBeNull();
  });

  it("never throws when storage access is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });

    expect(readSchemaFenceQuarantine("document-1")).toBeNull();
    expect(writeSchemaFenceQuarantine("document-1", { reason: "repair-detected" })).toBe(false);
    expect(() => clearSchemaFenceQuarantine("document-1")).not.toThrow();
  });
});
