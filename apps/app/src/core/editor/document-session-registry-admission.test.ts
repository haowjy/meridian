/** Authority admission, ordering, and persistence purge behavior. */
import { describe, expect, it, vi } from "vitest";
import { documentSessionPersistenceKey } from "./document-session-authority-store";
import {
  admit,
  DocumentSessionRegistry,
  databaseNames,
  expectAuthorityError,
  openBlocker,
  registryFor,
} from "./document-session-registry.test-support";

describe("DocumentSessionRegistry authority admission", () => {
  it("fails before lease or session creation when Web Locks are unavailable", async () => {
    vi.stubGlobal("navigator", { ...navigator, locks: undefined });
    const registry = new DocumentSessionRegistry(undefined, 0);
    registry.setOwnUserId("account-no-web-locks");
    await expect(admit(registry, "project", "doc", "1")).rejects.toEqual(
      expectAuthorityError("authority-unavailable"),
    );
    expect(() => registry.temporaryPeek("doc")).not.toThrow();
    expect(registry.temporaryPeek("doc")).toBeUndefined();
  });

  it("publishes immutable retained identities and isolates observer failures", async () => {
    const registry = await registryFor("account-retained-observer");
    const snapshots: Array<readonly { projectId: string; documentId: string }[]> = [];
    registry.observeRetainedLiveDocuments(() => {
      throw new Error("observer failure");
    });
    const stop = registry.observeRetainedLiveDocuments((snapshot) => snapshots.push(snapshot));
    const b = await admit(registry, "project-b", "doc-b", "1");
    const a = await admit(registry, "project-a", "doc-a", "1");

    expect(() => registry.retain("owner", [b, a])).not.toThrow();
    expect(snapshots.at(-1)).toEqual([
      { projectId: "project-a", documentId: "doc-a" },
      { projectId: "project-b", documentId: "doc-b" },
    ]);
    expect(Object.isFrozen(snapshots.at(-1))).toBe(true);

    await registry.revokeAccess("project-a", "doc-a", "1", "access-a-1");
    expect(snapshots.at(-1)).toEqual([{ projectId: "project-b", documentId: "doc-b" }]);
    registry.release("owner");
    expect(snapshots.at(-1)).toEqual([]);
    stop();
    registry.destroyAll();
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
    await vi.waitFor(async () => {
      await expect(registry.revokeDocument("project", "doc", "5", "terminal-5")).resolves.toEqual({
        revokedThrough: "5",
        persistence: "cleared",
      });
    });
    expect(await databaseNames()).not.toContain(oldName);
    expect(await databaseNames()).toContain(documentSessionPersistenceKey(accountId, "doc", "6"));
    registry.destroyAll();
  });
});
