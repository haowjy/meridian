/** Branch, legacy, detached, and ordinary session lifecycle behavior. */
import type { AuthMeResponse, ChangeEventWsMessage } from "@meridian/contracts/protocol";
import { WS_CLOSE } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "@/test-support/memory-storage";
import {
  admit,
  DocumentSessionRegistry,
  databaseNames,
  providers,
  registryFor,
} from "./document-session-registry.test-support";
import { clientSchemaReloadGuardKey } from "./schema-fence";

describe("DocumentSessionRegistry session lifecycle", () => {
  it("keeps branch generations separate from live authority and IndexedDB", async () => {
    const before = await databaseNames();
    const registry = new DocumentSessionRegistry();
    const first = registry.getBranchRoom("branch:branch-1:gen:1");
    const second = registry.getBranchRoom("branch:branch-1:gen:2");

    expect(first).not.toBe(second);
    expect(first.document).not.toBe(second.document);
    expect(await databaseNames()).toEqual(before);
    await registry.closeAccountRuntime();
  });

  it("runs the EditorView branch retain/get/release sequence with grace teardown", () => {
    vi.useFakeTimers();
    const registry = new DocumentSessionRegistry(undefined, 3_000);
    const firstKey = "branch:branch-production:gen:1";
    const secondKey = "branch:branch-production:gen:2";

    registry.retainBranchRooms("editor-view", [firstKey]);
    const first = registry.getBranchRoom(firstKey);
    registry.releaseBranchRooms("editor-view");
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

  it("owns rejecting provider teardown after a live session grace expires", async () => {
    const registry = await registryFor("account-live-grace-rejection");
    const lease = await admit(registry, "project", "doc-live-grace", "1");
    registry.retain("owner", [lease]);
    const session = registry.get(lease);
    await session.whenLocalPersistenceSynced();
    await vi.waitFor(() => expect(providers).toHaveLength(1));
    const provider = providers[0];
    const diagnostic = new Error("live grace destroy failed");
    provider.destroy.mockRejectedValueOnce(diagnostic).mockResolvedValueOnce(undefined);
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      registry.release("owner");
      await vi.waitFor(() => expect(registry.hasLive(lease)).toBe(false));
      expect(session.getSnapshot().status).toBe("destroyed");
      expect(provider.destroy).toHaveBeenCalledOnce();
      expect(() => registry.get(lease)).toThrow(
        expect.objectContaining({ kind: "authority-unavailable" }),
      );
      await expect(registry.closeAccountRuntime()).resolves.toBeUndefined();
      expect(provider.destroy).toHaveBeenCalledTimes(2);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
      await registry.closeAccountRuntime();
    }
  });

  it("owns rejecting provider teardown after an unleased branch grace expires", async () => {
    const registry = new DocumentSessionRegistry(undefined, 0);
    const roomKey = "branch:branch-grace-rejection:gen:1";
    registry.retainBranchRooms("review", [roomKey]);
    const session = registry.getBranchRoom(roomKey);
    providers
      .at(-1)
      ?.destroy.mockRejectedValueOnce(new Error("branch grace destroy failed"))
      .mockResolvedValueOnce(undefined);
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      registry.releaseBranchRooms("review");
      await vi.waitFor(() => expect(session.getSnapshot().status).toBe("destroyed"));
      expect(session.getSnapshot().status).toBe("destroyed");
      expect(() => registry.getBranchRoom(roomKey)).toThrow(
        expect.objectContaining({ kind: "authority-unavailable" }),
      );
      await expect(registry.closeAccountRuntime()).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
      await registry.closeAccountRuntime();
    }
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

  it("owns rejecting reset teardown while deleting the branch registry entry", async () => {
    const registry = new DocumentSessionRegistry(undefined, 0);
    const roomKey = "branch:branch-reset-rejection:gen:1";
    const first = registry.getBranchRoom(roomKey);
    providers
      .at(-1)
      ?.destroy.mockRejectedValueOnce(new Error("reset destroy failed"))
      .mockResolvedValueOnce(undefined);
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      providers.at(-1)?.emit({
        kind: "reset",
        reason: WS_CLOSE.BRANCH_STALE.reason,
        code: WS_CLOSE.BRANCH_STALE.code,
      });
      await vi.waitFor(() => expect(first.getSnapshot().status).toBe("destroyed"));
      expect(first.getSnapshot().status).toBe("destroyed");
      expect(() => registry.getBranchRoom(roomKey)).toThrow(
        expect.objectContaining({ kind: "authority-unavailable" }),
      );
      await expect(registry.closeAccountRuntime()).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
      await registry.closeAccountRuntime();
    }
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
    const registry = new DocumentSessionRegistry(undefined, 3_000, "account-grace");
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

  it("uses the authenticated internal id for marker self-suppression", async () => {
    const authMe = {
      user: {
        userId: "internal-user",
        externalId: "external-user",
        email: "writer@example.com",
        name: "Writer",
        avatarUrl: null,
      },
    } satisfies AuthMeResponse;
    const registry = new DocumentSessionRegistry(undefined, undefined, authMe.user.userId);
    const lease = await admit(registry, "project", "document-before-auth", "1");
    const session = registry.getDetached(lease);
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
    await firstRegistry.closeAccountRuntime();
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
