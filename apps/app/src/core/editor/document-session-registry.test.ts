/** Lease, fence, persistence-generation, and branch negative-space contracts. */
import "fake-indexeddb/auto";

import type { LiveDocumentSessionLease } from "@meridian/contracts/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentSessionConnectionState } from "./document-session";
import { documentSessionPersistenceKey } from "./document-session-authority-store";

const providers: Array<{
  emit: (state: DocumentSessionConnectionState) => void;
  destroy: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("@/core/transport/hocuspocus-document-transport", () => ({
  createHocuspocusDocumentTransport: () => {
    const listeners = new Set<(state: DocumentSessionConnectionState) => void>();
    const provider = {
      emit: (state: DocumentSessionConnectionState) => {
        for (const listener of listeners) listener(state);
      },
      destroy: vi.fn(),
    };
    providers.push(provider);
    return {
      synced: false,
      subscribeStatus: (listener: (state: DocumentSessionConnectionState) => void) => {
        listeners.add(listener);
        listener({ kind: "connecting", attempt: 1 });
        return () => listeners.delete(listener);
      },
      destroy: provider.destroy,
    };
  },
}));

const { DocumentSessionAuthorityError, DocumentSessionRegistry } = await import(
  "./document-session-registry"
);

type Registry = InstanceType<typeof DocumentSessionRegistry>;

async function registryFor(accountId: string): Promise<Registry> {
  const registry = new DocumentSessionRegistry(undefined, 0);
  registry.setOwnUserId(accountId);
  return registry;
}

async function databaseNames(): Promise<string[]> {
  return (await indexedDB.databases()).flatMap(({ name }) => (name ? [name] : []));
}

async function openBlocker(name: string): Promise<IDBDatabase> {
  const request = indexedDB.open(name);
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function expectAuthorityError(kind: InstanceType<typeof DocumentSessionAuthorityError>["kind"]) {
  return expect.objectContaining({ name: "DocumentSessionAuthorityError", kind });
}

async function admit(
  registry: Registry,
  projectId: string,
  documentId: string,
  generation: string,
): Promise<LiveDocumentSessionLease> {
  return registry.admit(projectId, documentId, generation);
}

afterEach(() => {
  providers.length = 0;
  vi.useRealTimers();
});

describe("DocumentSessionRegistry live authority", () => {
  it("shares one room, Y.Doc, and first persistence generation across project leases", async () => {
    const registry = await registryFor("account-shared");
    const a = await admit(registry, "project-a", "doc-shared", "10");
    const first = registry.get(a);
    await first.whenLocalPersistenceSynced();
    const b = await admit(registry, "project-b", "doc-shared", "14");
    const second = registry.get(b);

    expect(second).toBe(first);
    expect(second.document).toBe(first.document);
    expect(await databaseNames()).toContain(
      documentSessionPersistenceKey("account-shared", "doc-shared", "10"),
    );
    expect(await databaseNames()).not.toContain(
      documentSessionPersistenceKey("account-shared", "doc-shared", "14"),
    );
    registry.destroyAll();
  });

  it("revokes only B access while A retains the room, then globally revokes both", async () => {
    const registry = await registryFor("account-scope");
    const a = await admit(registry, "project-a", "doc", "3");
    const b = await admit(registry, "project-b", "doc", "4");
    const session = registry.get(a);

    await expect(registry.revokeAccess("project-b", "doc", "4", "access-b-4")).resolves.toEqual({
      revokedThrough: "4",
      persistence: "retained-by-other-lease",
    });
    expect(registry.get(a)).toBe(session);
    expect(() => registry.get(b)).toThrow(expectAuthorityError("stale-lease"));

    await expect(registry.revokeDocument("project-a", "doc", "5", "terminal-5")).resolves.toEqual({
      revokedThrough: "5",
      persistence: "cleared",
    });
    expect(session.getSnapshot().status).toBe("destroyed");
    expect(() => registry.get(a)).toThrow(expectAuthorityError("stale-lease"));
  });

  it("rejects older commands, replays equal commands, detects collisions, and lets newer win", async () => {
    const registry = await registryFor("account-order");
    const lease = await admit(registry, "project", "doc", "10");
    const session = registry.get(lease);

    await expect(registry.revokeDocument("project", "doc", "9", "terminal-9")).rejects.toEqual(
      expectAuthorityError("older-command"),
    );
    expect(registry.get(lease)).toBe(session);
    await expect(registry.revokeDocument("project", "doc", "10", "terminal-10")).resolves.toEqual({
      revokedThrough: "10",
      persistence: "cleared",
    });
    await expect(registry.revokeDocument("project", "doc", "10", "terminal-10")).resolves.toEqual({
      revokedThrough: "10",
      persistence: "cleared",
    });
    await expect(registry.revokeDocument("project", "doc", "10", "other-10")).rejects.toEqual(
      expectAuthorityError("command-collision"),
    );
    const newer = await admit(registry, "project", "doc", "11");
    expect(registry.get(newer)).not.toBe(session);
    await expect(registry.revokeDocument("project", "doc", "12", "terminal-12")).resolves.toEqual({
      revokedThrough: "12",
      persistence: "cleared",
    });
  });

  it("refuses barrier-released stale get, restart, and retain without recreating persistence", async () => {
    const registry = await registryFor("account-barrier");
    const lease = await admit(registry, "project", "doc", "2");
    registry.get(lease);
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const staleEffect = barrier.then(() => {
      expect(() => registry.get(lease)).toThrow(expectAuthorityError("stale-lease"));
      expect(() => registry.retain("stale-owner", [lease])).toThrow(
        expectAuthorityError("stale-lease"),
      );
      return registry.restartUnavailableRoom(lease);
    });

    await registry.revokeDocument("project", "doc", "2", "terminal-2");
    releaseBarrier();
    await expect(staleEffect).rejects.toEqual(expectAuthorityError("stale-lease"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await databaseNames()).not.toContain(
      documentSessionPersistenceKey("account-barrier", "doc", "2"),
    );
  });

  it("purges dormant persistence when no session is mounted", async () => {
    const registry = await registryFor("account-dormant");
    const lease = await admit(registry, "project", "doc", "6");
    registry.retain("owner", [lease]);
    const session = registry.get(lease);
    await session.whenLocalPersistenceSynced();
    registry.release("owner");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getSnapshot().status).toBe("destroyed");

    await registry.revokeDocument("project", "doc", "6", "terminal-6");
    expect(await databaseNames()).not.toContain(
      documentSessionPersistenceKey("account-dormant", "doc", "6"),
    );
  });

  it("keeps a blocked purge durable while a newer explicit reopen stays on fresh bytes", async () => {
    const accountId = "account-reopen";
    const registry = await registryFor(accountId);
    const oldLease = await admit(registry, "project", "doc", "5");
    const oldSession = registry.get(oldLease);
    oldSession.document.getText("words").insert(0, "old bytes");
    await oldSession.whenLocalPersistenceSynced();
    const oldName = documentSessionPersistenceKey(accountId, "doc", "5");
    const blocker = await openBlocker(oldName);

    await expect(registry.revokeDocument("project", "doc", "5", "terminal-5")).rejects.toEqual(
      expectAuthorityError("purge-pending"),
    );
    await expect(admit(registry, "project", "doc", "5")).rejects.toEqual(
      expectAuthorityError("generation-revoked"),
    );

    const newerLease = await admit(registry, "project", "doc", "6");
    const newerSession = registry.get(newerLease);
    await newerSession.whenLocalPersistenceSynced();
    expect(newerSession.document.getText("words").toString()).toBe("");
    expect(await databaseNames()).toContain(documentSessionPersistenceKey(accountId, "doc", "6"));

    blocker.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(registry.revokeDocument("project", "doc", "5", "terminal-5")).resolves.toEqual({
      revokedThrough: "5",
      persistence: "cleared",
    });
    expect(await databaseNames()).not.toContain(oldName);
    expect(await databaseNames()).toContain(documentSessionPersistenceKey(accountId, "doc", "6"));
    registry.destroyAll();
  });

  it("invalidates prior leases and isolates persistence on account switch", async () => {
    const registry = await registryFor("account-a");
    const firstLease = await admit(registry, "project", "doc", "1");
    const first = registry.get(firstLease);
    await first.whenLocalPersistenceSynced();

    registry.setOwnUserId("account-b");
    expect(first.getSnapshot().status).toBe("destroyed");
    expect(() => registry.get(firstLease)).toThrow(expectAuthorityError("account-mismatch"));
    const secondLease = await admit(registry, "project", "doc", "1");
    const second = registry.get(secondLease);
    await second.whenLocalPersistenceSynced();

    expect(second).not.toBe(first);
    expect(await databaseNames()).toEqual(
      expect.arrayContaining([
        documentSessionPersistenceKey("account-a", "doc", "1"),
        documentSessionPersistenceKey("account-b", "doc", "1"),
      ]),
    );
    registry.destroyAll();
  });

  it("keeps branch generations separate from live authority and IndexedDB", async () => {
    const before = await databaseNames();
    const registry = new DocumentSessionRegistry();
    const first = registry.getBranchRoom("branch:branch-1:gen:1");
    const second = registry.getBranchRoom("branch:branch-1:gen:2");

    expect(first).not.toBe(second);
    expect(first.document).not.toBe(second.document);
    expect(await databaseNames()).toEqual(before);
    registry.destroyAll();
  });
});
