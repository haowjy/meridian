/** CrossWS upgrade coverage for Yjs subprotocol echo response headers. */
import { WS_CLOSE } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWsUpgradeAuth: vi.fn(),
  gateway: {},
}));

vi.mock("nitro", () => ({
  defineWebSocketHandler: <T>(hooks: T) => hooks,
}));

vi.mock("../ws-upgrade-auth.js", () => ({
  deferWsClose: (close: typeof WS_CLOSE.AUTH_FAILED) => ({ kind: "deferred-close", close }),
  resolveWsUpgradeAuth: mocks.resolveWsUpgradeAuth,
}));

vi.mock("../yjs-ws-handler.js", () => ({
  createYjsGateway: () => mocks.gateway,
  selectYjsGatewayServices: () => ({}),
}));

const { yjsWebSocketHandler } = await import("../../routes/ws/yjs.js");

const handler = yjsWebSocketHandler as unknown as {
  upgrade(request: Request): Promise<{
    context: { kind: string };
    headers?: { "sec-websocket-protocol": string };
  }>;
};

const cases = [
  {
    name: "sole match",
    offered: "unrelated, meridian.collab.0.1.0",
    selected: "meridian.collab.0.1.0",
  },
  {
    name: "zero matches",
    offered: "unrelated, another",
    selected: "unrelated",
  },
  {
    name: "multiple matches",
    offered: "unrelated, meridian.collab.0.1.0, meridian.collab.0.2.0",
    selected: "unrelated",
  },
  {
    name: "no offers",
    offered: null,
    selected: undefined,
  },
] as const;

describe("Yjs WebSocket upgrade", () => {
  it.each([
    "authenticated",
    "deferred-close",
  ] as const)("retains every echo outcome for %s upgrades", async (authKind) => {
    mocks.resolveWsUpgradeAuth.mockResolvedValue(
      authKind === "authenticated"
        ? { kind: authKind, app: {}, userId: "user-1" }
        : { kind: authKind, close: WS_CLOSE.AUTH_FAILED },
    );

    for (const { name, offered, selected } of cases) {
      const response = await handler.upgrade(
        new Request("https://meridian.local/ws/yjs", {
          ...(offered ? { headers: { "sec-websocket-protocol": offered } } : {}),
        }),
      );

      expect(response.context.kind, name).toBe(authKind);
      if (selected) {
        expect(response.headers, name).toEqual({ "sec-websocket-protocol": selected });
      } else {
        expect("headers" in response, name).toBe(false);
      }
    }
  });
});
