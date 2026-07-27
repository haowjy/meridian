import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import { messageYjsSyncStep1, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { createBranchCoordinator } from "../../domains/collab/domain/branch-coordinator.js";
import { createBranchPullService } from "../../domains/collab/domain/branch-pulls.js";
import { StaleDocumentSchemaError } from "../../domains/collab/index.js";
import {
  admitWriterSync,
  type BranchHandshakeState,
  clientSchemaVersionFromRequest,
  createHocuspocus,
  createYjsGateway,
} from "../yjs-ws-handler.js";

const documentName = "branch:branch_1:gen:3";
const liveDocumentName = "00000000-0000-4000-8000-000000000101";
const userId = "00000000-0000-4000-8000-000000000102";

const payload = new Uint8Array([1, 2, 3]);

function services(stale: boolean) {
  return {
    documentAccess: {} as never,
    eventSink: {} as never,
    documentSync: {
      rejectStaleBranchSyncStep1: vi.fn(async () => stale),
      admitBranchWriterUpdate: vi.fn(async () => undefined),
    } as never,
  };
}

function gatewayServices() {
  return {
    documentAccess: {} as never,
    eventSink: {} as never,
    documentSync: { bindHocuspocus: () => undefined } as never,
  };
}

function versionGateServices(input: { liveHead?: number | null; branchHead?: number } = {}) {
  const documentSync = {
    bindHocuspocus: vi.fn(),
    headSchemaVersion: vi.fn(async () => input.liveHead ?? null),
    resolveBranchHocuspocusRoom: vi.fn(async (branchId: string, generation: number) => ({
      branchId,
      documentId: liveDocumentName,
      generation,
      schemaVersion: input.branchHead ?? COLLAB_SCHEMA_VERSION,
      status: "active" as const,
    })),
    resolveManifestMembership: vi.fn(async () => ({
      documentId: liveDocumentName,
      members: [liveDocumentName],
    })),
    reconcileProjectManifest: vi.fn(async () => undefined),
    currentLiveGeneration: vi.fn(async () => 1n),
    flushBranchLivePull: vi.fn(async () => undefined),
  };
  return {
    documentAccess: {
      canAccessDocument: vi.fn(async () => true),
      projectIdForDocument: vi.fn(async () => "00000000-0000-4000-8000-000000000103"),
    },
    documentSync,
    eventSink: { emit() {} },
  };
}

function connectContext(clientSchemaVersion: number) {
  return {
    userId,
    clientSchemaVersion,
    liveGenerations: new Map<string, bigint>(),
    closeTransport: vi.fn(),
  };
}

describe("Yjs connect-time schema version gate", () => {
  it("parses the declared schema version and treats absent or invalid values as zero", () => {
    expect(
      clientSchemaVersionFromRequest(new Request("https://meridian.local/ws/yjs?schema=4")),
    ).toBe(4);
    for (const url of [
      "https://meridian.local/ws/yjs",
      "https://meridian.local/ws/yjs?schema=",
      "https://meridian.local/ws/yjs?schema=-1",
      "https://meridian.local/ws/yjs?schema=1.5",
      "https://meridian.local/ws/yjs?schema=9007199254740992",
    ]) {
      expect(clientSchemaVersionFromRequest(new Request(url))).toBe(0);
    }
  });

  it("refuses only live-room clients strictly older than a stored head", async () => {
    const services = versionGateServices({ liveHead: COLLAB_SCHEMA_VERSION });
    const hocuspocus = createHocuspocus(services as never);
    const staleClientContext = connectContext(COLLAB_SCHEMA_VERSION - 1);

    await expect(
      hocuspocus.configuration.onConnect?.({
        documentName: liveDocumentName,
        context: staleClientContext,
      } as never),
    ).rejects.toMatchObject({ code: 4406, reason: "client-schema-superseded" });
    expect(staleClientContext.closeTransport).toHaveBeenCalledWith({
      code: 4406,
      reason: "client-schema-superseded",
    });
    await expect(
      hocuspocus.configuration.onConnect?.({
        documentName: liveDocumentName,
        context: connectContext(COLLAB_SCHEMA_VERSION),
      } as never),
    ).resolves.toBeUndefined();
    expect(services.documentSync.headSchemaVersion).toHaveBeenCalledWith(liveDocumentName);
  });

  it("passes a live room with no stamped head, including an absent-version client", async () => {
    const hocuspocus = createHocuspocus(versionGateServices({ liveHead: null }) as never);

    await expect(
      hocuspocus.configuration.onConnect?.({
        documentName: liveDocumentName,
        context: connectContext(0),
      } as never),
    ).resolves.toBeUndefined();
  });

  it("gates branch rooms at the same strict monotonic edge", async () => {
    const hocuspocus = createHocuspocus(
      versionGateServices({ branchHead: COLLAB_SCHEMA_VERSION }) as never,
    );
    const staleClientContext = connectContext(COLLAB_SCHEMA_VERSION - 1);

    await expect(
      hocuspocus.configuration.onConnect?.({
        documentName,
        context: staleClientContext,
      } as never),
    ).rejects.toMatchObject({ code: 4406, reason: "client-schema-superseded" });
    expect(staleClientContext.closeTransport).toHaveBeenCalledWith({
      code: 4406,
      reason: "client-schema-superseded",
    });
    await expect(
      hocuspocus.configuration.onConnect?.({
        documentName,
        context: connectContext(COLLAB_SCHEMA_VERSION),
      } as never),
    ).resolves.toBeUndefined();
  });

  it("refuses stale live and branch heads per connection with a typed close", async () => {
    const services = versionGateServices({
      liveHead: COLLAB_SCHEMA_VERSION - 1,
      branchHead: COLLAB_SCHEMA_VERSION - 1,
    });
    const hocuspocus = createHocuspocus(services as never);

    for (const room of [liveDocumentName, documentName]) {
      const context = connectContext(COLLAB_SCHEMA_VERSION);
      await expect(
        hocuspocus.configuration.onConnect?.({
          documentName: room,
          context,
        } as never),
      ).rejects.toMatchObject({ code: 4407, reason: "document-schema-stale" });
      expect(context.closeTransport).toHaveBeenCalledWith({
        code: 4407,
        reason: "document-schema-stale",
      });
    }
  });

  it.each([
    ["live", liveDocumentName],
    ["branch", documentName],
  ])("keeps the typed stale-head close on the %s document-load guard", async (_kind, room) => {
    const services = versionGateServices({ liveHead: null });
    Object.assign(services.documentSync, {
      loadHocuspocusDocument: vi.fn(async () => {
        throw new StaleDocumentSchemaError(
          liveDocumentName,
          COLLAB_SCHEMA_VERSION - 1,
          COLLAB_SCHEMA_VERSION,
        );
      }),
      loadHocuspocusBranchState: vi.fn(async () => {
        throw new StaleDocumentSchemaError(
          liveDocumentName,
          COLLAB_SCHEMA_VERSION - 1,
          COLLAB_SCHEMA_VERSION,
        );
      }),
    });
    const hocuspocus = createHocuspocus(services as never);
    const context = connectContext(COLLAB_SCHEMA_VERSION);

    await expect(
      hocuspocus.configuration.onLoadDocument?.({
        documentName: room,
        document: new Y.Doc({ gc: false }),
        context,
      } as never),
    ).rejects.toMatchObject({ code: 4407, reason: "document-schema-stale" });
    expect(context.closeTransport).toHaveBeenCalledWith({
      code: 4407,
      reason: "document-schema-stale",
    });
  });
});

describe("Yjs branch handshake route guard", () => {
  it("pulls live changes into a Work draft without blocking branch-room connection", async () => {
    const live = new Y.Doc({ gc: false });
    live.getText("content").insert(0, "live advanced");
    const loadedRoom = new Y.Doc({ gc: false });
    let storedState = Y.encodeStateAsUpdate(new Y.Doc({ gc: false }));
    let releasePull: (() => void) | undefined;
    const pullBlocked = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const branchCoordinator = createBranchCoordinator({
      store: {
        getBranch: async () => ({
          branchId: "branch_1",
          documentId: "document-1" as never,
          kind: "work_draft",
          upstreamBranchId: null,
          workId: "work-1" as never,
          threadId: null,
          pushPolicy: "manual",
          status: "active",
          generation: 3,
          state: storedState,
          stateVector: Y.encodeStateVectorFromUpdate(storedState),
          discardedStateVector: null,
          schemaVersion: COLLAB_SCHEMA_VERSION,
        }),
        async updateBranchSnapshot(input) {
          await pullBlocked;
          storedState = input.state;
          return true;
        },
        deferUntilCommit: () => false,
      },
      onBranchUpdate: ({ update }) => {
        Y.applyUpdate(loadedRoom, update);
      },
    });
    const branchPulls = createBranchPullService({
      liveCoordinator: {
        withDocument: async (_documentId, fn) => fn(live),
        recover: async () => {},
      },
      branchCoordinator,
      branches: {
        listActiveWorkDraftBranchIds: async () => ["branch_1"],
        ensureWorkDraftBranch: async () => ({ branchId: "branch_1" }),
        ensureThreadPeerBranch: async () => ({ branchId: "thread-peer" }),
      },
    });
    const flushBranchLivePull = vi.fn(branchPulls.flushLivePull);
    const hocuspocus = createHocuspocus({
      documentAccess: {
        canAccessDocument: vi.fn(async () => true),
      } as never,
      documentSync: {
        bindHocuspocus: vi.fn(),
        resolveBranchHocuspocusRoom: vi.fn(async () => ({
          branchId: "branch_1",
          documentId: "document-1",
          generation: 3,
          schemaVersion: COLLAB_SCHEMA_VERSION,
          status: "active",
        })),
        headSchemaVersion: vi.fn(async () => null),
        flushBranchLivePull,
      } as never,
      eventSink: { emit() {} } as never,
    });

    await expect(
      hocuspocus.configuration.onConnect?.({
        documentName,
        context: { userId: "user-1", clientSchemaVersion: COLLAB_SCHEMA_VERSION },
      } as never),
    ).resolves.toBeUndefined();
    expect(flushBranchLivePull).toHaveBeenCalledWith("document-1");
    expect(loadedRoom.getText("content").toString()).toBe("");

    releasePull?.();
    await flushBranchLivePull.mock.results[0]?.value;
    await vi.waitFor(() => {
      expect(loadedRoom.getText("content").toString()).toBe("live advanced");
    });
    const persisted = new Y.Doc({ gc: false });
    Y.applyUpdate(persisted, storedState);
    expect(persisted.getText("content").toString()).toBe("live advanced");
  });

  it("rejects hostile branch payloads before returning them to Hocuspocus", async () => {
    const admitBranchWriterUpdate = vi.fn(async () => {
      throw new Error("reserved provenance");
    });
    const closeTransport = vi.fn();
    const document = new Y.Doc();

    await expect(
      admitWriterSync({
        services: {
          ...services(false),
          documentSync: { admitBranchWriterUpdate } as never,
        },
        documentName,
        document,
        syncType: messageYjsUpdate,
        payload,
        userId: "user-1" as never,
        closeTransport,
        context: {
          branchSyncState: new Map([["branch_1:3", "passed"]]),
        },
      }),
    ).rejects.toMatchObject({ reason: "branch-update-admission-failed", code: 1008 });
    expect(admitBranchWriterUpdate).toHaveBeenCalledWith({
      branchId: "branch_1",
      expectedGeneration: 3,
      update: new Uint8Array([1, 2, 3]),
      origin: { type: "user", userId: "user-1" },
      document,
    });
    expect(closeTransport).toHaveBeenCalledWith({
      code: 1008,
      reason: "branch-update-admission-failed",
    });
  });

  it("waits for branch durability before returning the update to Hocuspocus", async () => {
    let commit: (() => void) | undefined;
    const admitBranchWriterUpdate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          commit = resolve;
        }),
    );
    const admission = admitWriterSync({
      services: {
        ...services(false),
        documentSync: { admitBranchWriterUpdate } as never,
      },
      documentName,
      document: new Y.Doc(),
      syncType: messageYjsUpdate,
      payload,
      userId: "user-1" as never,
      context: {
        branchSyncState: new Map([["branch_1:3", "passed"]]),
      },
    });

    await Promise.resolve();
    let returned = false;
    void admission.then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);

    commit?.();
    await expect(admission).resolves.toBeUndefined();
    expect(returned).toBe(true);
  });

  it("rejects update-first sync messages", async () => {
    const state = new Map<string, BranchHandshakeState>();
    await expect(
      admitWriterSync({
        services: services(false),
        documentName,
        document: new Y.Doc(),
        syncType: messageYjsUpdate,
        payload,
        userId: "user-1" as never,
        context: { branchSyncState: state },
      }),
    ).rejects.toMatchObject({ reason: "branch-stale-doc", code: 4205 });
    expect(state.get("branch_1:3")).toBe("rejected");
  });

  it("keeps a rejected room rejected when a later step1 would pass", async () => {
    const state = new Map<string, BranchHandshakeState>();
    await expect(
      admitWriterSync({
        services: services(false),
        documentName,
        document: new Y.Doc(),
        syncType: messageYjsUpdate,
        payload,
        userId: "user-1" as never,
        context: { branchSyncState: state },
      }),
    ).rejects.toMatchObject({ reason: "branch-stale-doc" });
    await expect(
      admitWriterSync({
        services: services(false),
        documentName,
        document: new Y.Doc(),
        syncType: messageYjsSyncStep1,
        payload,
        userId: "user-1" as never,
        context: { branchSyncState: state },
      }),
    ).rejects.toMatchObject({ reason: "branch-stale-doc", code: 4205 });
    expect(state.get("branch_1:3")).toBe("rejected");
  });

  it("allows a fresh client to pass step1 then send updates", async () => {
    const state = new Map<string, BranchHandshakeState>();
    await admitWriterSync({
      services: services(false),
      documentName,
      document: new Y.Doc(),
      syncType: messageYjsSyncStep1,
      payload,
      userId: "user-1" as never,
      context: { branchSyncState: state },
    });
    await expect(
      admitWriterSync({
        services: services(false),
        documentName,
        document: new Y.Doc(),
        syncType: messageYjsUpdate,
        payload,
        userId: "user-1" as never,
        context: { branchSyncState: state },
      }),
    ).resolves.toBeUndefined();
    expect(state.get("branch_1:3")).toBe("passed");
  });

  it("clears branch sync state through the route close handler", async () => {
    const state = new Map<string, BranchHandshakeState>([["branch_1:3", "rejected"]]);
    const handleClose = vi.fn();
    const gateway = createYjsGateway(gatewayServices());
    const connection = {
      hocuspocus: { handleClose },
      branchSyncState: state,
      offlineSyncUpdates: new Set<string>(),
      liveGenerations: new Map<string, bigint>(),
    };

    gateway.close(connection as never, { code: 1000, reason: "test" });

    expect(handleClose).toHaveBeenCalledWith({ code: 1000, reason: "test" });
    expect(state.size).toBe(0);
  });

  it("clears branch sync state through the route error handler", async () => {
    const state = new Map<string, BranchHandshakeState>([["branch_1:3", "rejected"]]);
    const handleClose = vi.fn();
    const gateway = createYjsGateway(gatewayServices());
    const connection = {
      hocuspocus: { handleClose },
      branchSyncState: state,
      offlineSyncUpdates: new Set<string>(),
      liveGenerations: new Map<string, bigint>(),
    };

    gateway.error(connection as never);

    expect(handleClose).toHaveBeenCalledWith({ code: 1011, reason: "error" });
    expect(state.size).toBe(0);
  });

  it("stops connection admission synchronously when drain starts", async () => {
    let finishPersistenceDrain: (() => void) | undefined;
    const persistenceDrain = new Promise<void>((resolve) => {
      finishPersistenceDrain = resolve;
    });
    const gateway = createYjsGateway({
      ...gatewayServices(),
      eventSink: { emit: vi.fn() } as never,
      documentSync: {
        bindHocuspocus: () => undefined,
        getPersistenceQueueMetrics: () => ({}),
        drainHocuspocusPersistence: () => persistenceDrain,
      } as never,
    });
    const drain = gateway.drain();
    const close = vi.fn();

    const connection = gateway.connect({
      request: new Request("https://server.localhost/ws/yjs"),
      userId: "user-1" as never,
      clientSchemaVersion: COLLAB_SCHEMA_VERSION,
      close,
      socket: {
        send: vi.fn(),
        close: vi.fn(),
        readyState: 1,
      },
    });

    expect(connection).toBeUndefined();
    expect(close).toHaveBeenCalledWith(1012, "server-shutdown");
    finishPersistenceDrain?.();
    await drain;
  });
});

describe("Yjs live writer admission", () => {
  it("accepts a non-empty system update only after journal, then applies, broadcasts, and acks", async () => {
    const client = new Y.Doc({ gc: false });
    client.getText("content").insert(0, "non-empty system update");
    const payload = Y.encodeStateAsUpdate(client);
    const server = new Y.Doc({ gc: false });
    const events: string[] = [];
    let commit: (() => void) | undefined;
    const admitLiveWriterUpdate = vi.fn(
      () =>
        new Promise<{ admitted: true; joinedSettlement: boolean }>((resolve) => {
          events.push("accept");
          commit = () => {
            events.push("journal");
            resolve({ admitted: true, joinedSettlement: true });
          };
        }),
    );
    const admission = admitWriterSync({
      services: {
        ...services(false),
        documentSync: { admitLiveWriterUpdate } as never,
      },
      documentName: "document-1",
      document: server,
      syncType: messageYjsUpdate,
      payload,
      userId: "user-1" as never,
    });

    await Promise.resolve();
    expect(admitLiveWriterUpdate).toHaveBeenCalledWith({
      documentId: "document-1",
      document: server,
      update: payload,
      origin: { type: "user", userId: "user-1" },
      expectedGeneration: 1n,
    });
    let returnedToHocuspocus = false;
    void admission.then(() => {
      Y.applyUpdate(server, payload);
      events.push("apply", "broadcast", "ack");
      returnedToHocuspocus = true;
    });
    await Promise.resolve();
    expect(returnedToHocuspocus).toBe(false);
    commit?.();
    await admission;
    expect(returnedToHocuspocus).toBe(true);
    expect(server.getText("content").toString()).toBe("non-empty system update");
    expect(events).toEqual(["accept", "journal", "apply", "broadcast", "ack"]);
  });

  it("does not send an empty update to PostgreSQL bytea admission", async () => {
    const admitLiveWriterUpdate = vi.fn();
    await expect(
      admitWriterSync({
        services: {
          ...services(false),
          documentSync: { admitLiveWriterUpdate } as never,
        },
        documentName: "document-1",
        document: new Y.Doc(),
        syncType: messageYjsUpdate,
        payload: new Uint8Array(),
        userId: "user-1" as never,
      }),
    ).resolves.toBeUndefined();
    expect(admitLiveWriterUpdate).not.toHaveBeenCalled();
  });

  it("returns a contained admission without closing the transport", async () => {
    const payload = new Uint8Array([0, 0]);
    const admitLiveWriterUpdate = vi.fn(async () => ({
      admitted: false as const,
      joinedSettlement: false as const,
    }));
    const closeTransport = vi.fn();

    await expect(
      admitWriterSync({
        services: {
          ...services(false),
          documentSync: { admitLiveWriterUpdate } as never,
        },
        documentName: "document-1",
        document: new Y.Doc(),
        syncType: messageYjsUpdate,
        payload,
        userId: "user-1" as never,
        closeTransport,
      }),
    ).resolves.toEqual({ admitted: false, joinedSettlement: false });
    expect(closeTransport).not.toHaveBeenCalled();
  });

  it("rejects a failed admission and accepts the client's resubmitted update", async () => {
    const payload = new Uint8Array([7, 8, 9]);
    const admitLiveWriterUpdate = vi
      .fn()
      .mockRejectedValueOnce(new Error("journal down"))
      .mockResolvedValueOnce({ admitted: true, joinedSettlement: false });
    const closeTransport = vi.fn();
    const input = {
      services: {
        ...services(false),
        documentSync: { admitLiveWriterUpdate } as never,
      },
      documentName: "document-1",
      document: new Y.Doc(),
      syncType: messageYjsUpdate,
      payload,
      userId: "user-1" as never,
      closeTransport,
    };

    await expect(admitWriterSync(input)).rejects.toMatchObject({
      reason: "writer-journal-admission-failed",
      code: 1013,
    });
    expect(closeTransport).toHaveBeenCalledWith({
      code: 1013,
      reason: "writer-journal-admission-failed",
    });
    await expect(admitWriterSync(input)).resolves.toEqual({
      admitted: true,
      joinedSettlement: false,
    });
    expect(admitLiveWriterUpdate).toHaveBeenCalledTimes(2);
  });
});
