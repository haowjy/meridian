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

async function eventually(assertion: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
});

describe("DocumentSessionAuthorityStore", () => {
  it("selects one durable incarnation and keeps monotonic admission heads", async () => {
    const store = new DocumentSessionAuthorityStore("account-room-order");
    await expect(
      store.admit({ documentId: "doc", projectId: "project-a", generation: "3" }),
    ).resolves.toMatchObject({ kind: "admitted", persistenceGeneration: "3" });
    await expect(
      store.admit({ documentId: "doc", projectId: "project-b", generation: "4" }),
    ).resolves.toMatchObject({ kind: "admitted", persistenceGeneration: "3" });
    await expect(store.readRoom("doc")).resolves.toMatchObject({
      persistenceGeneration: "3",
      documentAdmittedThrough: "4",
    });
    await expect(store.readAccessHead("doc", "project-a")).resolves.toBe("3");
    await expect(store.readAccessHead("doc", "project-b")).resolves.toBe("4");
    await store.close();
  });

  it("persists requested drain separately from lifecycle-proven purge readiness", async () => {
    const store = new DocumentSessionAuthorityStore("account-pending-proof");
    await store.admit({ documentId: "doc", projectId: "project", generation: "5" });
    await expect(
      store.startDocumentDrain({ documentId: "doc", generation: "5", commandId: "terminal-5" }),
    ).resolves.toMatchObject({ kind: "started" });
    expect(await store.pendingPurges()).toEqual([]);
    await expect(store.readRoom("doc")).resolves.toMatchObject({
      persistenceGeneration: null,
      pendingDrain: { kind: "document", generation: "5", commandId: "terminal-5" },
    });
    await store.finishDocumentDrain({
      documentId: "doc",
      generation: "5",
      commandId: "terminal-5",
    });
    await expect(store.pendingPurges()).resolves.toMatchObject([{ revokedThrough: "5" }]);
    await expect(store.readRoom("doc")).resolves.toMatchObject({ pendingDrain: null });
    await store.close();
  });

  it("stores the exact access outcome for replay", async () => {
    const accountId = "account-access-outcome";
    const store = new DocumentSessionAuthorityStore(accountId);
    await store.admit({ documentId: "doc", projectId: "project-b", generation: "4" });
    await store.startAccessDrain({
      documentId: "doc",
      projectId: "project-b",
      generation: "4",
      commandId: "access-b-4",
    });
    await store.finishAccessDrain({
      documentId: "doc",
      projectId: "project-b",
      generation: "4",
      commandId: "access-b-4",
      persistence: "retained-by-other-lease",
    });
    await store.close();

    const reloaded = new DocumentSessionAuthorityStore(accountId);
    await expect(
      reloaded.startAccessDrain({
        documentId: "doc",
        projectId: "project-b",
        generation: "4",
        commandId: "access-b-4",
      }),
    ).resolves.toEqual({
      kind: "replay",
      revokedThrough: "4",
      persistence: "retained-by-other-lease",
    });
    await reloaded.close();
  });

  it("rejects older document and project-qualified commands before advancing fences", async () => {
    const accountId = "account-admitted-through";
    const store = new DocumentSessionAuthorityStore(accountId);
    await store.admit({ documentId: "doc", projectId: "project-a", generation: "10" });
    await store.admit({ documentId: "doc", projectId: "project-b", generation: "4" });
    await expect(
      store.startDocumentDrain({ documentId: "doc", generation: "9", commandId: "terminal-9" }),
    ).resolves.toMatchObject({ kind: "older" });
    await expect(
      store.startAccessDrain({
        documentId: "doc",
        projectId: "project-a",
        generation: "9",
        commandId: "access-a-9",
      }),
    ).resolves.toMatchObject({ kind: "older" });
    await expect(
      store.startAccessDrain({
        documentId: "doc",
        projectId: "project-b",
        generation: "4",
        commandId: "access-b-4",
      }),
    ).resolves.toMatchObject({ kind: "started" });
    expect(await store.readFence(documentFenceKey(accountId, "doc"))).toBeNull();
    expect(await store.readFence(accessFenceKey(accountId, "project-a", "doc"))).toBeNull();
    await store.close();
  });

  it("blocks a lower admission on proven purge but preserves a later incarnation", async () => {
    const store = new DocumentSessionAuthorityStore("account-purge-barrier");
    await store.admit({ documentId: "doc", projectId: "project-b", generation: "5" });
    await store.startAccessDrain({
      documentId: "doc",
      projectId: "project-b",
      generation: "5",
      commandId: "access-b-5",
    });
    await store.finishAccessDrain({
      documentId: "doc",
      projectId: "project-b",
      generation: "5",
      commandId: "access-b-5",
      persistence: "cleared",
    });
    await expect(
      store.admit({ documentId: "doc", projectId: "project-a", generation: "4" }),
    ).resolves.toEqual({ kind: "purge-barrier", purgeThrough: "5" });
    await expect(
      store.admit({ documentId: "doc", projectId: "project-a", generation: "10" }),
    ).resolves.toMatchObject({ kind: "admitted", persistenceGeneration: "10" });
    await store.startAccessDrain({
      documentId: "doc",
      projectId: "project-b",
      generation: "6",
      commandId: "access-b-6",
    });
    await store.finishAccessDrain({
      documentId: "doc",
      projectId: "project-b",
      generation: "6",
      commandId: "access-b-6",
      persistence: "cleared",
    });
    await expect(store.readRoom("doc")).resolves.toMatchObject({ persistenceGeneration: "10" });
    await store.close();
  });

  it("compare-clears only the captured ready bound and never snapshots pending newer work", async () => {
    const accountId = "account-purge-cas";
    const store = new DocumentSessionAuthorityStore(accountId);
    await store.advanceFence({
      key: documentFenceKey(accountId, "doc"),
      documentId: "doc",
      revokedThrough: "5",
      commandId: "terminal-5",
      purge: true,
    });
    const old = await store.snapshotPurge("doc");
    expect(old?.revokedThrough).toBe("5");
    if (!old) throw new Error("Expected the old purge snapshot");
    await store.advanceFence({
      key: documentFenceKey(accountId, "doc"),
      documentId: "doc",
      revokedThrough: "7",
      commandId: "terminal-7",
      purge: true,
    });
    await expect(store.compareClearPurge(old)).resolves.toBe(false);
    await expect(store.pendingPurges()).resolves.toMatchObject([{ revokedThrough: "7" }]);

    await store.admit({ documentId: "other", projectId: "project", generation: "10" });
    await store.advanceFence({
      key: documentFenceKey(accountId, "other"),
      documentId: "other",
      revokedThrough: "5",
      commandId: "terminal-other-5",
      purge: true,
    });
    await store.startDocumentDrain({
      documentId: "other",
      generation: "12",
      commandId: "terminal-other-12",
    });
    await expect(store.snapshotPurge("other")).resolves.toBeNull();
    await expect(store.pendingPurges()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentId: "other", revokedThrough: "5" }),
      ]),
    );
    await store.close();
  });
  it("compares decimal server generations numerically", () => {
    expect(compareAvailabilityGeneration("9", "10")).toBe(-1);
    expect(compareAvailabilityGeneration("10000000000000000000", "9999999999999999999")).toBe(1);
  });

  it("rejects every noncanonical generation at comparison and key construction", () => {
    for (const generation of ["", "+1", "-1", " 1", "1 ", "0x10", "01", "00"]) {
      expect(() => compareAvailabilityGeneration(generation, "1")).toThrow(TypeError);
      expect(() => documentSessionPersistenceKey("account", "doc", generation)).toThrow(TypeError);
    }
    expect(
      parseDocumentSessionPersistenceKey("meridian:document:v1.0:live/account/doc/01"),
    ).toBeNull();
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

  it("keeps durable purge work when database enumeration is unavailable", async () => {
    const accountId = "account-no-enumeration";
    const documentId = "doc";
    const name = documentSessionPersistenceKey(accountId, documentId, "2");
    await openDatabase(name).then((database) => database.close());
    opened.pop();
    const idbWithoutEnumeration = {
      open: indexedDB.open.bind(indexedDB),
      deleteDatabase: indexedDB.deleteDatabase.bind(indexedDB),
      cmp: indexedDB.cmp.bind(indexedDB),
    } as IDBFactory;
    const store = new DocumentSessionAuthorityStore(accountId, idbWithoutEnumeration);
    await store.advanceFence({
      key: documentFenceKey(accountId, documentId),
      documentId,
      revokedThrough: "2",
      commandId: "terminal-2",
      purge: true,
    });

    await expect(store.retryPendingPurges()).resolves.toBe(false);
    expect(await store.pendingPurges()).toHaveLength(1);
    expect((await indexedDB.databases()).map(({ name: databaseName }) => databaseName)).toContain(
      name,
    );
    await store.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });

  it("resumes the same blocked job and deletes every qualifying database", async () => {
    const accountId = "account-multiple-blocked";
    const documentId = "doc";
    const firstName = documentSessionPersistenceKey(accountId, documentId, "3");
    const secondName = documentSessionPersistenceKey(accountId, documentId, "4");
    const firstBlocker = await openDatabase(firstName);
    await openDatabase(secondName).then((database) => database.close());
    opened.pop();
    const store = new DocumentSessionAuthorityStore(accountId);
    await store.advanceFence({
      key: documentFenceKey(accountId, documentId),
      documentId,
      revokedThrough: "4",
      commandId: "terminal-4",
      purge: true,
    });

    await expect(store.retryPendingPurges()).resolves.toBe(false);
    firstBlocker.close();
    opened.splice(opened.indexOf(firstBlocker), 1);

    await eventually(async () => {
      await store.retryPendingPurges();
      expect(await store.pendingPurges()).toEqual([]);
      const names = (await indexedDB.databases()).map(({ name }) => name);
      expect(names).not.toContain(firstName);
      expect(names).not.toContain(secondName);
    });
    await store.close();
  });
});
