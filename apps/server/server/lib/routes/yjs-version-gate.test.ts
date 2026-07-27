/** Connect-time schema compatibility behavior for live and Work-draft Yjs rooms. */
import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { StaleDocumentSchemaError } from "../../domains/collab/index.js";
import { clientSchemaVersionFromRequest, createHocuspocus } from "../yjs-ws-handler.js";

const branchRoomName = "branch:branch_1:gen:3";
const liveDocumentName = "00000000-0000-4000-8000-000000000101";
const userId = "00000000-0000-4000-8000-000000000102";

function versionGateServices(input: { liveHead?: number | null; branchHead?: number } = {}) {
  const documentSync = {
    bindHocuspocus: vi.fn(),
    headSchemaVersion: vi.fn(async () => (input.liveHead === undefined ? null : input.liveHead)),
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

function staleSchemaError() {
  return new StaleDocumentSchemaError(
    liveDocumentName,
    COLLAB_SCHEMA_VERSION - 1,
    COLLAB_SCHEMA_VERSION,
  );
}

describe("Yjs connect-time schema version gate", () => {
  it("parses decimal schema versions and treats absent or malformed values as zero", () => {
    expect(
      clientSchemaVersionFromRequest(new Request("https://meridian.local/ws/yjs?schema=4")),
    ).toBe(4);
    for (const url of [
      "https://meridian.local/ws/yjs",
      "https://meridian.local/ws/yjs?schema=",
      "https://meridian.local/ws/yjs?schema=-1",
      "https://meridian.local/ws/yjs?schema=1.5",
      "https://meridian.local/ws/yjs?schema=1e3",
      "https://meridian.local/ws/yjs?schema=0x10",
      "https://meridian.local/ws/yjs?schema=%2B4",
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
    expect(services.documentSync.headSchemaVersion).toHaveBeenCalledTimes(2);
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
        documentName: branchRoomName,
        context: staleClientContext,
      } as never),
    ).rejects.toMatchObject({ code: 4406, reason: "client-schema-superseded" });
    expect(staleClientContext.closeTransport).toHaveBeenCalledWith({
      code: 4406,
      reason: "client-schema-superseded",
    });
    await expect(
      hocuspocus.configuration.onConnect?.({
        documentName: branchRoomName,
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

    for (const room of [liveDocumentName, branchRoomName]) {
      const context = connectContext(COLLAB_SCHEMA_VERSION);
      await expect(
        hocuspocus.configuration.onConnect?.({ documentName: room, context } as never),
      ).rejects.toMatchObject({ code: 4407, reason: "document-schema-stale" });
      expect(context.closeTransport).toHaveBeenCalledWith({
        code: 4407,
        reason: "document-schema-stale",
      });
    }
  });

  it("maps a stale manifest dependency to the same typed close", async () => {
    const services = versionGateServices({ liveHead: COLLAB_SCHEMA_VERSION });
    services.documentSync.resolveManifestMembership.mockRejectedValue(staleSchemaError());
    const hocuspocus = createHocuspocus(services as never);
    const context = connectContext(COLLAB_SCHEMA_VERSION);

    await expect(
      hocuspocus.configuration.onConnect?.({
        documentName: liveDocumentName,
        context,
      } as never),
    ).rejects.toMatchObject({ code: 4407, reason: "document-schema-stale" });
    expect(context.closeTransport).toHaveBeenCalledWith({
      code: 4407,
      reason: "document-schema-stale",
    });
  });

  it.each([
    ["live", liveDocumentName],
    ["branch", branchRoomName],
  ])("keeps the typed stale-head close on the %s document-load guard", async (_kind, room) => {
    const services = versionGateServices({ liveHead: null });
    Object.assign(services.documentSync, {
      loadHocuspocusDocument: vi.fn(async () => {
        throw staleSchemaError();
      }),
      loadHocuspocusBranchState: vi.fn(async () => {
        throw staleSchemaError();
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
