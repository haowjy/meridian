// @vitest-environment jsdom

import type { Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { announce } = vi.hoisted(() => ({ announce: vi.fn() }));

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((copy, part, index) => copy + part + (values[index] ?? ""), ""),
}));
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

function ToolHarness({ toolName }: { toolName: string }) {
  const live = turn("streaming");
  live.blocks = [
    {
      id: "block-1",
      sequence: 1,
      blockType: "tool_use",
      status: "partial",
      content: {
        toolCallId: "call-1",
        toolName,
        input:
          toolName === "write" ? { command: "replace", path: "manuscript://Chapter 1.md" } : {},
      },
    } as unknown as Turn["blocks"][number],
  ];
  useLiveTurnAnnouncements(
    "thread-1",
    live,
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

  it("announces writer activity without transport tool names", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => root.render(<ToolHarness toolName="write" />));

    expect(announce).toHaveBeenCalledWith("Editing…");
    expect(announce).not.toHaveBeenCalledWith(expect.stringMatching(/write|command=/i));
    await act(async () => root.unmount());
  });

  it("does not announce hidden or unknown protocol tools", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => root.render(<ToolHarness toolName="return_result" />));

    expect(announce).not.toHaveBeenCalledWith(
      expect.stringMatching(/return_result|return result/i),
    );
    await act(async () => root.unmount());
  });
});
