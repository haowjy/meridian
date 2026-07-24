// @vitest-environment jsdom

import type { Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { announce } = vi.hoisted(() => ({ announce: vi.fn() }));

vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));
vi.mock("@/client/stores", () => ({ announce, announceError: vi.fn() }));
vi.mock("./error-telemetry", () => ({ reportChatError: vi.fn() }));

import { useLiveTurnAnnouncements } from "./useLiveTurnAnnouncements";

function turn(status: Turn["status"]): Turn {
  return {
    id: "turn-1",
    threadId: "thread-1",
    role: "assistant",
    status,
    createdAt: "2026-07-24T00:00:00.000Z",
    blocks: [],
  } as unknown as Turn;
}

function Harness({ status }: { status: Turn["status"] }) {
  useLiveTurnAnnouncements(
    "thread-1",
    turn(status),
    { current: null },
    { current: document.createElement("div") },
  );
  return null;
}

afterEach(() => {
  announce.mockReset();
  document.body.replaceChildren();
});

describe("useLiveTurnAnnouncements", () => {
  it("announces a cancelled turn as stopped", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => root.render(<Harness status="streaming" />));
    announce.mockClear();
    await act(async () => root.render(<Harness status="cancelled" />));

    expect(announce).toHaveBeenCalledWith("Stopped");
    expect(announce).not.toHaveBeenCalledWith("Turn cancelled");

    await act(async () => root.unmount());
  });
});
