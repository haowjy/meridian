/** Production-adapter contract coverage for document transport status subscription. */

import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

vi.mock("@hocuspocus/provider", () => {
  const WebSocketStatus = {
    Connected: "connected",
    Connecting: "connecting",
    Disconnected: "disconnected",
  } as const;

  class HocuspocusProviderWebsocket {
    readonly status = WebSocketStatus.Disconnected;

    async connect(): Promise<void> {}
    destroy(): void {}
  }

  class HocuspocusProvider {
    readonly synced = false;
    readonly unsyncedChanges = 0;

    attach(): void {}
    destroy(): void {}
  }

  return { HocuspocusProvider, HocuspocusProviderWebsocket, WebSocketStatus };
});

vi.mock("./dev-transport", () => ({
  buildSameOriginWsUrl: () => "ws://test/api/yjs",
}));

vi.mock("./tapped-websocket", () => ({
  notifyYjsRoomAttached: () => {},
  TappedWebSocket: class {},
}));

const {
  classifyDocumentTransportClose,
  createHocuspocusDocumentTransport,
  schemaVersionedYjsWsPath,
} = await import("./hocuspocus-document-transport");

describe("Hocuspocus document transport adapter", () => {
  it.each([
    [4406, "client-schema-superseded"],
    [4407, "document-schema-stale"],
  ] as const)("classifies schema refusal %i as a typed reset", (code, reason) => {
    expect(classifyDocumentTransportClose("document-1", { code, reason: "untrusted" })).toEqual({
      kind: "reset",
      reason,
      code,
    });
  });

  it("leaves existing terminal and branch close classifications unchanged", () => {
    expect(
      classifyDocumentTransportClose("document-1", {
        code: 4403,
        reason: "permission-denied",
      }),
    ).toEqual({ kind: "unauthorized", reason: "permission-denied", code: 4403 });
    expect(
      classifyDocumentTransportClose("branch:draft-1:gen:1", {
        code: 4205,
        reason: "branch-stale-doc",
      }),
    ).toEqual({ kind: "reset", reason: "branch-stale-doc", code: 4205 });
    expect(
      classifyDocumentTransportClose("document-1", {
        code: 1006,
        reason: "",
      }),
    ).toBeNull();
  });

  it("declares the bundle schema version on each document socket URL", () => {
    expect(schemaVersionedYjsWsPath()).toBe(`/ws/yjs?schema=${COLLAB_SCHEMA_VERSION}`);
  });

  it("emits its initial status before subscribeStatus returns", () => {
    const document = new Y.Doc();
    const awareness = new Awareness(document);
    const transport = createHocuspocusDocumentTransport({
      roomName: "document-1",
      document,
      awareness,
    });
    if (!transport.subscribeStatus) throw new Error("subscribeStatus is required");

    let initialStatus: unknown;
    const unsubscribe = transport.subscribeStatus((status) => {
      initialStatus = status;
    });

    expect(initialStatus).toEqual({ kind: "disconnected" });

    unsubscribe();
    transport.destroy();
    awareness.destroy();
    document.destroy();
  });
});
