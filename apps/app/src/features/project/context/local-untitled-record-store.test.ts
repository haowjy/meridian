// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { BrowserLocalUntitledRecordStore } from "./local-untitled-record-store";

describe("BrowserLocalUntitledRecordStore", () => {
  beforeEach(() => localStorage.clear());

  it("isolates account, project, and document records without aggregate overwrite", () => {
    const store = new BrowserLocalUntitledRecordStore(localStorage);
    const first = {
      key: { accountId: "account/a", projectId: "project/a", documentId: "document/a" },
      lineageId: "lineage-a",
      revision: 1,
      phase: "local-pending" as const,
      home: null,
    };
    const second = {
      ...first,
      key: { ...first.key, documentId: "document/b" },
      lineageId: "lineage-b",
    };
    store.write(first);
    store.write(second);
    expect(store.read(first.key)).toEqual(first);
    expect(store.read(second.key)).toEqual(second);
    expect(store.list("account/a")).toHaveLength(2);
  });

  it("ignores malformed residue and removes only an exact revision", () => {
    const store = new BrowserLocalUntitledRecordStore(localStorage);
    localStorage.setItem("meridian:pending-untitled:v2:account-a:bad", "{");
    const record = {
      key: { accountId: "account-a", projectId: "project-a", documentId: "document-a" },
      lineageId: "lineage-a",
      revision: 3,
      phase: "local-pending" as const,
      home: null,
    };
    store.write(record);
    expect(store.remove(record.key, 2)).toBe("stale");
    expect(store.read(record.key)).toEqual(record);
    expect(store.remove(record.key, 3)).toBe("removed");
  });
});
