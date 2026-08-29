/** Lease, fence, persistence-generation, and branch negative-space contracts. */
import "fake-indexeddb/auto";

import {
  type AuthMeResponse,
  type ChangeEventWsMessage,
  type LiveDocumentSessionLease,
  WS_CLOSE,
} from "@meridian/contracts/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentSessionConnectionState } from "./document-session";
import { documentSessionPersistenceKey } from "./document-session-authority-store";
import { clientSchemaReloadGuardKey } from "./schema-fence";

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
const { DocumentSessionAuthorityStore } = await import("./document-session-authority-store");
const { memoryStorage } = await import("@/test-support/memory-storage");

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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class AdmissionBarrierStore {
  readonly entered = deferred();
  readonly release = deferred();
  private readCount = 0;

  constructor(
    private readonly delegate: InstanceType<typeof DocumentSessionAuthorityStore>,
    private readonly pauseOnRead = 1,
  ) {}

  close() {
    return this.delegate.close();
  }
  readFence(...args: Parameters<InstanceType<typeof DocumentSessionAuthorityStore>["readFence"]>) {
    return this.delegate.readFence(...args);
  }
  advanceFence(
    ...args: Parameters<InstanceType<typeof DocumentSessionAuthorityStore>["advanceFence"]>
  ) {
    return this.delegate.advanceFence(...args);
  }
  retryPendingPurges() {
    return this.delegate.retryPendingPurges();
  }
  async readAdmissionFences(
    ...args: Parameters<InstanceType<typeof DocumentSessionAuthorityStore>["readAdmissionFences"]>
  ) {
    const fences = await this.delegate.readAdmissionFences(...args);
    this.readCount += 1;
    if (this.readCount === this.pauseOnRead) {
      this.entered.resolve();
      await this.release.promise;
    }
    return fences;
  }
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
  vi.unstubAllGlobals();
});

describe("DocumentSessionRegistry live authority", () => {
  it("serializes a document revoke that arrives during the combined admission read", async () => {
    const barrierStore = new AdmissionBarrierStore(
      new DocumentSessionAuthorityStore("account-admit-race"),
    );
    const registry = new DocumentSessionRegistry(() => barrierStore, 0);
    registry.setOwnUserId("account-admit-race");
    const admitting = admit(registry, "project", "doc", "5");
    await barrierStore.entered.promise;
    let revokeSettled = false;
    const revoking = registry.revokeDocument("project", "doc", "5", "terminal-5").then((result) => {
      revokeSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(revokeSettled).toBe(false);

    barrierStore.release.resolve();
    const lease = await admitting;
    await expect(revoking).resolves.toEqual({ revokedThrough: "5", persistence: "cleared" });
    expect(() => registry.get(lease)).toThrow(expectAuthorityError("stale-lease"));
  });

  it("serializes another project admission before deciding access-revoke retention", async () => {
    const barrierStore = new AdmissionBarrierStore(
      new DocumentSessionAuthorityStore("account-access-race"),
      2,
    );
    const registry = new DocumentSessionRegistry(() => barrierStore, 0);
    registry.setOwnUserId("account-access-race");
    const b = await admit(registry, "project-b", "doc", "4");
    registry.get(b);
    const aAdmission = admit(registry, "project-a", "doc", "5");
    await barrierStore.entered.promise;
    const revoking = registry.revokeAccess("project-b", "doc", "4", "access-b-4");
    barrierStore.release.resolve();
    const a = await aAdmission;

    await expect(revoking).resolves.toEqual({
      revokedThrough: "4",
      persistence: "retained-by-other-lease",
    });
    expect(registry.get(a).getSnapshot().status).not.toBe("destroyed");
  });

  it("refuses process-state commit when the account switches during admission", async () => {
    const barrierStore = new AdmissionBarrierStore(
      new DocumentSessionAuthorityStore("account-inflight-a"),
    );
    const registry = new DocumentSessionRegistry(
      (accountId) =>
        accountId === "account-inflight-a"
          ? barrierStore
          : new DocumentSessionAuthorityStore(accountId),
      0,
    );
    registry.setOwnUserId("account-inflight-a");
    const admitting = admit(registry, "project", "doc", "1");
    await barrierStore.entered.promise;

    registry.setOwnUserId("account-inflight-b");
    barrierStore.release.resolve();
    await expect(admitting).rejects.toEqual(expectAuthorityError("account-mismatch"));
    const b = await admit(registry, "project", "doc", "1");
    expect(registry.get(b).getSnapshot().status).not.toBe("destroyed");
  });

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

  it("applies the same exact command ordering to project access fences", async () => {
    const registry = await registryFor("account-access-order");
    const lease = await admit(registry, "project", "doc", "10");
    registry.get(lease);

    await expect(registry.revokeAccess("project", "doc", "9", "access-9")).rejects.toEqual(
      expectAuthorityError("older-command"),
    );
    await expect(registry.revokeAccess("project", "doc", "10", "access-10")).resolves.toEqual({
      revokedThrough: "10",
      persistence: "cleared",
    });
    await expect(registry.revokeAccess("project", "doc", "10", "access-10")).resolves.toEqual({
      revokedThrough: "10",
      persistence: "cleared",
    });
    await expect(registry.revokeAccess("project", "doc", "10", "other-10")).rejects.toEqual(
      expectAuthorityError("command-collision"),
    );
    const newer = await admit(registry, "project", "doc", "11");
    expect(registry.get(newer).getSnapshot().status).not.toBe("destroyed");
    await expect(registry.revokeAccess("project", "doc", "12", "access-12")).resolves.toEqual({
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

  it("runs the EditorView branch retain/get/release sequence with grace teardown", () => {
    vi.useFakeTimers();
    const registry = new DocumentSessionRegistry(undefined, 3_000);
    const firstKey = "branch:branch-production:gen:1";
    const secondKey = "branch:branch-production:gen:2";

    registry.temporaryRetain("editor-view", [firstKey]);
    const first = registry.temporaryGet(firstKey);
    registry.temporaryRelease("editor-view");
    vi.advanceTimersByTime(2_900);
    expect(first.getSnapshot().status).not.toBe("destroyed");
    vi.advanceTimersByTime(100);
    expect(first.getSnapshot().status).toBe("destroyed");

    registry.retainBranchRooms("editor-view", [secondKey]);
    const second = registry.getBranchRoom(secondKey);
    expect(second).not.toBe(first);
    expect(second.document).not.toBe(first.document);
    registry.releaseBranchRooms("editor-view");
    vi.advanceTimersByTime(3_000);
    expect(second.getSnapshot().status).toBe("destroyed");
  });

  it("removes a reset branch generation so the same fenced name reacquires cleanly", async () => {
    const registry = new DocumentSessionRegistry(undefined, 0);
    registry.retainBranchRooms("review", ["branch:branch-reset:gen:7"]);
    const first = registry.getBranchRoom("branch:branch-reset:gen:7");
    const provider = providers.at(-1);
    provider?.emit({
      kind: "reset",
      reason: WS_CLOSE.BRANCH_STALE.reason,
      code: WS_CLOSE.BRANCH_STALE.code,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = registry.getBranchRoom("branch:branch-reset:gen:7");
    expect(first.getSnapshot().status).toBe("destroyed");
    expect(second).not.toBe(first);
    registry.releaseBranchRooms("review");
  });

  it("retires legacy live state before admission and rejects legacy acquisition afterward", async () => {
    const registry = new DocumentSessionRegistry(undefined, 0);
    registry.setOwnUserId("account-transition");
    const legacy = registry.temporaryGetDetached("legacy-first");
    legacy.document.getText("words").insert(0, "unfenced");
    const lease = await admit(registry, "project", "legacy-first", "5");
    const canonical = registry.getDetached(lease);

    expect(legacy.getSnapshot().status).toBe("destroyed");
    expect(canonical).not.toBe(legacy);
    expect(canonical.document.getText("words").toString()).toBe("");

    const admittedFirst = await admit(registry, "project", "admit-first", "5");
    expect(() => registry.temporaryGetDetached("admit-first")).toThrow(
      expectAuthorityError("stale-lease"),
    );
    expect(registry.getDetached(admittedFirst).getSnapshot().status).toBe("detached");
  });

  it("keeps detached words and Y.Doc through explicit attach and denied restart", async () => {
    const registry = await registryFor("account-detached");
    const lease = await admit(registry, "project", "document-detached", "1");
    registry.retain("untitled-tab", [lease], { detachedDocumentIds: [lease.documentId] });
    const detached = registry.getDetached(lease);
    detached.document.getText("words").insert(0, "local words");
    const document = detached.document;

    expect(detached.getSnapshot().status).toBe("detached");
    await expect(registry.restartUnavailableRoom(lease)).resolves.toBe(false);
    expect(registry.attachDetached(lease)).toBe(detached);
    await detached.waitForCurrentSync(100);
    providers.at(-1)?.emit({ kind: "unauthorized", reason: "not materialized", code: 4403 });
    await expect(registry.restartUnavailableRoom(lease)).resolves.toBe(true);
    expect(registry.get(lease).document).toBe(document);
    expect(document.getText("words").toString()).toBe("local words");
  });

  it("restarts a full grace window after re-retention and peek does not cancel it", async () => {
    const registry = new DocumentSessionRegistry(undefined, 3_000);
    registry.setOwnUserId("account-grace");
    const lease = await admit(registry, "project", "doc-grace", "1");
    vi.useFakeTimers();
    registry.retain("owner", [lease]);
    const session = registry.get(lease);
    registry.release("owner");
    vi.advanceTimersByTime(2_800);
    expect(registry.peekLive(lease)).toBe(session);
    registry.retain("owner", [lease]);
    registry.release("owner");
    vi.advanceTimersByTime(200);
    expect(registry.hasLive(lease)).toBe(true);
    vi.advanceTimersByTime(2_800);
    expect(registry.hasLive(lease)).toBe(false);
    expect(session.getSnapshot().status).toBe("destroyed");
  });

  it("delivers observers to sessions created later and preserves healthy restart", async () => {
    const registry = await registryFor("account-observer");
    const lease = await admit(registry, "project", "doc-observer", "1");
    const statuses: string[] = [];
    const unobserve = registry.observeLive(lease, (snapshot) => statuses.push(snapshot.status));
    const session = registry.get(lease);
    await session.waitForCurrentSync(100);
    await expect(registry.restartUnavailableRoom(lease)).resolves.toBe(false);
    providers.at(-1)?.emit({ kind: "unauthorized", reason: "revoked", code: 4403 });
    expect(statuses).toContain("access-lost");
    unobserve();
  });

  it("uses the authenticated internal id for marker self-suppression", () => {
    const authMe = {
      user: {
        userId: "internal-user",
        externalId: "external-user",
        email: "writer@example.com",
        name: "Writer",
        avatarUrl: null,
      },
    } satisfies AuthMeResponse;
    const registry = new DocumentSessionRegistry();
    const session = registry.temporaryGetDetached("document-before-auth");
    registry.setOwnUserId(authMe.user.userId);
    const event = (admittedByUserId: string, trailId: string): ChangeEventWsMessage => ({
      type: "change_event",
      documentId: "document-before-auth",
      threadId: "thread-1",
      trailId,
      projectionRevision: 1,
      author: { kind: "agent", threadId: "thread-1", turnId: "turn-1" },
      changes: [
        {
          changeId: trailId,
          admittedByUserId,
          kind: "delete",
          navigation: {
            kind: "deletion_boundary",
            position: "invalid-but-lazily-decoded",
            affinity: "before_next",
          },
          swept: false,
          excerpt: null,
          pureDeletionOffset: null,
        },
      ],
      truncated: false,
    });
    session.markerStore.replaceGroup(event(authMe.user.externalId, "external"));
    session.markerStore.replaceGroup(event(authMe.user.userId, "internal"));
    expect(session.markerStore.getSnapshot().map((marker) => marker.group.trailId)).toEqual([
      "external",
    ]);
  });

  it("reacquires a schema-fenced canonical session without attaching transport", async () => {
    const localStorage = memoryStorage();
    const sessionStorage = memoryStorage();
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal("sessionStorage", sessionStorage);
    sessionStorage.setItem(clientSchemaReloadGuardKey("document-quarantined"), "1");
    const firstRegistry = await registryFor("account-schema");
    const firstLease = await admit(firstRegistry, "project", "document-quarantined", "1");
    const first = firstRegistry.get(firstLease);
    await first.whenLocalPersistenceSynced();
    await new Promise((resolve) => setTimeout(resolve, 0));
    providers.at(-1)?.emit({
      kind: "reset",
      reason: WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED.reason,
      code: WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED.code,
    });
    expect(first.getSnapshot().schemaFence).toEqual({ reason: "client-superseded" });
    firstRegistry.destroyAll();
    const providerCount = providers.length;

    const secondRegistry = await registryFor("account-schema");
    const secondLease = await admit(secondRegistry, "project", "document-quarantined", "1");
    const reacquired = secondRegistry.get(secondLease);
    expect(reacquired.getSnapshot()).toEqual(
      expect.objectContaining({ status: "detached", schemaFence: { reason: "client-superseded" } }),
    );
    expect(providers).toHaveLength(providerCount);
  });
});
