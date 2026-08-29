import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";

import {
  accessFenceKey,
  compareAvailabilityGeneration,
  DocumentSessionAuthorityStore,
  documentFenceKey,
  documentSessionPersistenceKey,
  parseDocumentSessionPersistenceKey,
} from "./document-session-authority-store";

const opened: IDBDatabase[] = [];

async function openDatabase(name: string): Promise<IDBDatabase> {
  const request = indexedDB.open(name);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  opened.push(database);
  return database;
}

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
});

describe("DocumentSessionAuthorityStore", () => {
  it("compares decimal server generations numerically", () => {
    expect(compareAvailabilityGeneration("9", "10")).toBe(-1);
    expect(compareAvailabilityGeneration("10000000000000000000", "9999999999999999999")).toBe(1);
  });

  it("orders older, idempotent, colliding, and newer fence commands", async () => {
    const store = new DocumentSessionAuthorityStore("account-order");
    const key = documentFenceKey("account-order", "doc");
    await expect(
      store.advanceFence({
        key,
        documentId: "doc",
        revokedThrough: "10",
        commandId: "c10",
        purge: false,
      }),
    ).resolves.toMatchObject({ kind: "advanced" });
    await expect(
      store.advanceFence({
        key,
        documentId: "doc",
        revokedThrough: "9",
        commandId: "c9",
        purge: false,
      }),
    ).resolves.toMatchObject({ kind: "older" });
    await expect(
      store.advanceFence({
        key,
        documentId: "doc",
        revokedThrough: "10",
        commandId: "c10",
        purge: false,
      }),
    ).resolves.toMatchObject({ kind: "idempotent" });
    await expect(
      store.advanceFence({
        key,
        documentId: "doc",
        revokedThrough: "10",
        commandId: "other",
        purge: false,
      }),
    ).resolves.toMatchObject({ kind: "collision" });
    await expect(
      store.advanceFence({
        key,
        documentId: "doc",
        revokedThrough: "11",
        commandId: "c11",
        purge: false,
      }),
    ).resolves.toMatchObject({ kind: "advanced" });
    await store.close();
  });

  it("keeps document and project access fences separate", async () => {
    const store = new DocumentSessionAuthorityStore("account-fences");
    await store.advanceFence({
      key: accessFenceKey("account-fences", "project-b", "doc"),
      documentId: "doc",
      revokedThrough: "4",
      commandId: "b4",
      purge: false,
    });
    expect(await store.readFence(documentFenceKey("account-fences", "doc"))).toBeNull();
    expect(await store.readFence(accessFenceKey("account-fences", "project-b", "doc"))).toEqual({
      revokedThrough: "4",
      commandId: "b4",
    });
    await store.close();
  });

  it("qualifies and parses live persistence without overlapping accounts or generations", () => {
    const key = documentSessionPersistenceKey("account/a", "document/b", "42");
    expect(parseDocumentSessionPersistenceKey(key)).toEqual({
      accountId: "account/a",
      documentId: "document/b",
      generation: "42",
    });
    expect(
      parseDocumentSessionPersistenceKey(
        key.replace(/meridian:document:v\d+\.\d+:/, "meridian:document:v1.0:"),
      ),
    ).toEqual({ accountId: "account/a", documentId: "document/b", generation: "42" });
    expect(parseDocumentSessionPersistenceKey("branch:branch-1:gen:42")).toBeNull();
  });

  it("persists blocked dormant purge work and clears it after the blocker closes", async () => {
    const accountId = "account-blocked";
    const documentId = "doc";
    const oldName = documentSessionPersistenceKey(accountId, documentId, "5");
    const newerName = documentSessionPersistenceKey(accountId, documentId, "7");
    const blocker = await openDatabase(oldName);
    await openDatabase(newerName).then((database) => database.close());
    opened.pop();

    const first = new DocumentSessionAuthorityStore(accountId);
    await first.advanceFence({
      key: documentFenceKey(accountId, documentId),
      documentId,
      revokedThrough: "5",
      commandId: "terminal-5",
      purge: true,
    });
    await expect(first.retryPendingPurges()).resolves.toBe(false);
    expect(await first.pendingPurges()).toHaveLength(1);
    await first.close();

    const reloaded = new DocumentSessionAuthorityStore(accountId);
    expect(await reloaded.pendingPurges()).toHaveLength(1);
    blocker.close();
    opened.splice(opened.indexOf(blocker), 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(reloaded.retryPendingPurges()).resolves.toBe(true);
    expect(await reloaded.pendingPurges()).toEqual([]);
    expect((await indexedDB.databases()).map(({ name }) => name)).toContain(newerName);
    expect((await indexedDB.databases()).map(({ name }) => name)).not.toContain(oldName);
    await reloaded.close();
  });
});
