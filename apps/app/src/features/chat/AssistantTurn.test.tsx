// @vitest-environment jsdom

import type { Block, Turn } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeTrailShell } from "@/client/change-trails";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Plural: ({ value }: { value: number }) => <>{value}</>,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((copy, part, index) => copy + part + (values[index] ?? ""), ""),
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));

const { documentsRef } = vi.hoisted(() => ({
  documentsRef: {
    current: null as null | { uri: string; path: string; scope: "live" | "draft" }[],
  },
}));

vi.mock("@/client/query/useTurnLiveLineage", () => ({
  useTurnLiveLineage: () => ({ documents: documentsRef.current }),
}));
vi.mock("@/client/query/useReverseMutation", () => ({
  useReverseTurnMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("./ChatContextNavigation", () => ({
  useChatContextNavigation: () => null,
}));

const { AssistantTurn } = await import("./AssistantTurn");

afterEach(() => {
  document.body.replaceChildren();
});

function turn(id: string, status: Turn["status"] = "complete"): Turn {
  return {
    id,
    threadId: "thread-1",
    role: "assistant",
    writeMode: null,
    status,
    createdAt: "2026-07-04T00:00:00.000Z",
    blocks: [],
  } as unknown as Turn;
}

function block(sequence: number, blockType: Block["blockType"], content: Block["content"]): Block {
  return {
    id: `block-${sequence}`,
    turnId: "turn-1",
    sequence,
    blockType,
    status: "complete",
    content,
    textContent: blockType === "reasoning" ? "Considering the chapter." : null,
  } as Block;
}

describe("AssistantTurn edit lineage", () => {
  it("renders no edit card without lineage documents", () => {
    documentsRef.current = [];
    const html = renderToStaticMarkup(<AssistantTurn threadId="thread-1" turn={turn("turn-1")} />);
    expect(html).not.toContain("data-turn-edits-card");
  });

  it("renders the edit card from server lineage", () => {
    documentsRef.current = [{ uri: "context://doc/chapter-1", path: "/chapter-1", scope: "live" }];
    const html = renderToStaticMarkup(<AssistantTurn threadId="thread-1" turn={turn("turn-1")} />);
    expect(html).toContain("data-turn-edits-card");
    expect(html).toContain("Undo");
  });

  it("keeps the committed lineage when a turn drafted and the writer applied", () => {
    // The live-lineage endpoint returns the draft entry BEFORE the live entry for
    // the same URI. Deduping to the first match hid the applied edit entirely.
    documentsRef.current = [
      { uri: "context://doc/chapter-3", path: "/chapter-3", scope: "draft" },
      { uri: "context://doc/chapter-3", path: "/chapter-3", scope: "live" },
    ];
    const html = renderToStaticMarkup(<AssistantTurn threadId="thread-1" turn={turn("turn-1")} />);
    expect(html).toContain("data-turn-edits-card");
  });

  it("describes a cancelled turn in the writer's voice", () => {
    documentsRef.current = [];
    const html = renderToStaticMarkup(
      <AssistantTurn threadId="thread-1" turn={turn("turn-1", "cancelled")} />,
    );

    expect(html).toContain("Stopped.");
    expect(html).not.toContain("Turn cancelled");
  });
});

describe("AssistantTurn process fold", () => {
  it("keeps live frontier tools visible and folds them behind the digest on settle", async () => {
    documentsRef.current = [];
    const blocks = [
      block(0, "reasoning", null),
      block(1, "tool_use", {
        toolCallId: "read-1",
        toolName: "write",
        input: { command: "read", path: "Chapter 1.md" },
      }),
      block(2, "tool_result", {
        toolCallId: "read-1",
        toolName: "write",
        output: "chapter body",
      }),
    ];

    const liveHtml = renderToStaticMarkup(
      <AssistantTurn turn={{ ...turn("turn-1", "streaming"), blocks }} />,
    );
    const settledHtml = renderToStaticMarkup(
      <AssistantTurn turn={{ ...turn("turn-1", "complete"), blocks }} />,
    );
    const liveHost = document.createElement("div");
    liveHost.innerHTML = liveHtml;
    const settledHost = document.createElement("div");
    settledHost.innerHTML = settledHtml;
    const isReadRow = (row: Element) =>
      row.textContent?.includes("Read") && row.textContent.includes("Chapter 1");
    const liveToolRow = [...liveHost.querySelectorAll("[data-activity-row]")].find(isReadRow);
    expect(liveHtml).toContain('aria-label="Thinking"');
    expect(liveToolRow).toBeDefined();
    expect(liveToolRow?.closest("[data-process-fold]")).toBeNull();
    expect(settledHost.textContent).toContain("Explored 1 document");
    expect(settledHtml).toContain('aria-label="Thinking"');

    const interactiveHost = document.createElement("div");
    document.body.append(interactiveHost);
    const root = createRoot(interactiveHost);
    await act(async () =>
      root.render(<AssistantTurn turn={{ ...turn("turn-1", "complete"), blocks }} />),
    );
    const disclosure = interactiveHost.querySelector<HTMLButtonElement>("[aria-label='Thinking']");
    await act(async () => disclosure?.click());
    const settledToolRow = [...interactiveHost.querySelectorAll("[data-activity-row]")].find(
      isReadRow,
    );
    expect(settledToolRow?.closest("[data-process-fold]")).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("reloads settled draft vocabulary from the turn after review data disappears", () => {
    documentsRef.current = [];
    const blocks = [
      block(0, "tool_use", {
        toolCallId: "write-1",
        toolName: "write",
        input: { command: "replace", path: "Chapter 1.md" },
      }),
      block(1, "tool_result", {
        toolCallId: "write-1",
        toolName: "write",
        output: "done",
      }),
    ];
    const settledDraftTurn = {
      ...turn("turn-1", "complete"),
      writeMode: "draft" as const,
      blocks,
    };

    const beforeReviewListEmpties = renderToStaticMarkup(<AssistantTurn turn={settledDraftTurn} />);
    documentsRef.current = [];
    const afterReload = renderToStaticMarkup(<AssistantTurn turn={settledDraftTurn} />);

    for (const html of [beforeReviewListEmpties, afterReload]) {
      expect(html).toContain("Drafted Chapter 1");
      expect(html).not.toContain("Edited Chapter 1");
    }
  });

  it("excludes hidden ask-user protocol rows from digests across an interrupt boundary", () => {
    documentsRef.current = [];
    const blocks = [
      block(0, "tool_use", {
        toolCallId: "ask-1",
        toolName: "ask_user",
        input: { question: "Which ending?" },
      }),
      block(1, "custom", { interrupt: { id: "interrupt-1" } }),
      block(2, "tool_result", {
        toolCallId: "ask-1",
        output: { value: "The quiet ending", provenance: "user" },
      }),
    ];

    const html = renderToStaticMarkup(
      <AssistantTurn turn={{ ...turn("turn-1", "complete"), blocks }} />,
    );

    expect(html).not.toContain("+1 step");
    expect(html).not.toContain("+2 steps");
    expect(html).not.toContain("Ask user");
  });

  it("keeps frontier prose and interrupt card DOM identity when tools fold on settle", async () => {
    documentsRef.current = [];
    const prose = {
      ...block(2, "text", "The gate opened."),
      textContent: "The gate opened.",
    };
    const interrupt = block(3, "custom", {
      kind: "free-text",
      props: {
        question: "Which path?",
        recommended: null,
        requiresHuman: true,
        resolvedValue: "The northern road",
        answerProvenance: "user",
      },
      interrupt: { id: "interrupt-1" },
    });
    const blocks = [
      block(0, "tool_use", {
        toolCallId: "read-1",
        toolName: "write",
        input: { command: "read", path: "Chapter 1.md" },
      }),
      block(1, "tool_result", {
        toolCallId: "read-1",
        toolName: "write",
        output: "chapter body",
      }),
      prose,
      interrupt,
    ];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () =>
      root.render(<AssistantTurn turn={{ ...turn("turn-1", "streaming"), blocks }} />),
    );
    const proseBefore = [...host.querySelectorAll("p")].find(
      (element) => element.textContent === "The gate opened.",
    );
    const interruptBefore = [...host.querySelectorAll("section")].find((element) =>
      element.textContent?.includes("The northern road"),
    );

    await act(async () =>
      root.render(<AssistantTurn turn={{ ...turn("turn-1", "complete"), blocks }} />),
    );
    const proseAfter = [...host.querySelectorAll("p")].find(
      (element) => element.textContent === "The gate opened.",
    );
    const interruptAfter = [...host.querySelectorAll("section")].find((element) =>
      element.textContent?.includes("The northern road"),
    );

    expect(proseBefore).toBeDefined();
    expect(proseAfter).toBe(proseBefore);
    expect(interruptBefore).toBeDefined();
    expect(interruptAfter).toBe(interruptBefore);
    const disclosure = host.querySelector<HTMLButtonElement>("[aria-label='Thinking']");
    await act(async () => disclosure?.click());
    expect(host.querySelector("[data-process-fold]")?.textContent).toContain("Chapter 1");

    await act(async () => root.unmount());
  });

  it("excludes a visible live frontier edit from the folded activity digest", () => {
    documentsRef.current = [];
    const blocks = [
      block(0, "tool_use", {
        toolCallId: "read-1",
        toolName: "write",
        input: { command: "read", path: "Chapter 1.md" },
      }),
      block(1, "tool_result", {
        toolCallId: "read-1",
        toolName: "write",
        output: "chapter body",
      }),
      block(2, "reasoning", null),
      block(3, "tool_use", {
        toolCallId: "edit-1",
        toolName: "write",
        input: { command: "replace", path: "Chapter 2.md" },
      }),
      block(4, "tool_result", {
        toolCallId: "edit-1",
        toolName: "write",
        output: "done",
      }),
    ];
    const html = renderToStaticMarkup(
      <AssistantTurn turn={{ ...turn("turn-1", "streaming"), blocks }} />,
    );
    const host = document.createElement("div");
    host.innerHTML = html;
    const fold = host.querySelector("[data-process-fold]");
    const digest = fold?.parentElement?.querySelector("button");

    expect(digest?.textContent).toContain("Explored 1 document");
    expect(digest?.textContent).not.toContain("Edited Chapter 2");
    expect(host.textContent).toContain("Edited");
    expect(host.textContent).toContain("Chapter 2");
  });
});

describe("AssistantTurn live ink drop", () => {
  it.each([
    "pending",
    "streaming",
  ] satisfies Turn["status"][])("renders at the growing edge while the turn is %s", (status) => {
    documentsRef.current = [];
    const html = renderToStaticMarkup(<AssistantTurn turn={turn("turn-1", status)} />);
    const host = document.createElement("div");
    host.innerHTML = html;

    expect(host.querySelector("[data-live-turn-ink] .ink-drop")).not.toBeNull();
    expect(host.querySelector(".ink-drop")?.getAttribute("aria-hidden")).not.toBeNull();
    expect(
      host.querySelector("[data-turn-id]")?.lastElementChild?.hasAttribute("data-live-turn-ink"),
    ).toBe(true);
  });

  it.each([
    "waiting_interrupt",
    "complete",
    "cancelled",
    "error",
  ] satisfies Turn["status"][])("does not render when the turn is %s", (status) => {
    documentsRef.current = [];
    const html = renderToStaticMarkup(<AssistantTurn turn={turn("turn-1", status)} />);
    expect(html).not.toContain("data-live-turn-ink");
  });

  it("aligns under the icon rail after a visible tool and at the prose edge otherwise", () => {
    documentsRef.current = [];
    const toolBlock = block(0, "tool_use", {
      toolCallId: "read-1",
      toolName: "write",
      input: { command: "read", path: "Chapter 1.md" },
    });
    const proseBlock = {
      ...block(1, "text", "The gate opened."),
      textContent: "The gate opened.",
    };
    const renderInk = (blocks: Block[]) => {
      const html = renderToStaticMarkup(
        <AssistantTurn turn={{ ...turn("turn-1", "streaming"), blocks }} />,
      );
      const host = document.createElement("div");
      host.innerHTML = html;
      return host.querySelector("[data-live-turn-ink]");
    };

    expect(renderInk([toolBlock])?.classList.contains("pl-[3.5px]")).toBe(true);
    expect(renderInk([toolBlock, proseBlock])?.classList.contains("pl-[3.5px]")).toBe(false);
    expect(renderInk([])?.classList.contains("pl-[3.5px]")).toBe(false);
  });
});

describe("AssistantTurn change view", () => {
  it("keeps an errored turn's settled change view reachable across reload", async () => {
    documentsRef.current = [];
    const stableTurn = turn("turn-1", "error");
    const navigateToChange = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const trail = (state: ChangeTrailShell["state"], version: number): ChangeTrailShell => ({
      trailId: "trail-1",
      owner: { kind: "turn", threadId: "thread-1", turnId: stableTurn.id },
      state,
      version,
      changeCount: 2,
      sweptChangeCount: 0,
      documents: [{ documentId: "document-1", title: "Chapter 1" }],
      wordsAdded: null,
      wordsRemoved: null,
      updatedAt: `2026-07-04T00:00:0${version}.000Z`,
      settledAt: state === "settled" ? `2026-07-04T00:00:0${version}.000Z` : null,
    });
    const renderTrail = (changeTrail: ChangeTrailShell) => (
      <QueryClientProvider client={queryClient}>
        <AssistantTurn
          threadId="thread-1"
          turn={stableTurn}
          changeTrail={changeTrail}
          navigateToChange={navigateToChange}
        />
      </QueryClientProvider>
    );

    await act(async () => root.render(renderTrail(trail("building", 2))));
    expect(host.querySelector("[data-turn-edits-card]")).toBeNull();

    await act(async () => root.render(renderTrail(trail("settled", 3))));
    expect(host.querySelector("[data-turn-edits-card]")).not.toBeNull();
    expect(host.querySelector("[data-change-trail-state]")).toBeNull();
    expect(host.textContent).not.toContain("Finishing change record…");

    await act(async () => root.unmount());

    const reloadedHost = document.createElement("div");
    document.body.append(reloadedHost);
    const reloadedRoot = createRoot(reloadedHost);
    await act(async () => reloadedRoot.render(renderTrail(trail("settled", 3))));
    expect(reloadedHost.querySelector("[data-turn-edits-card]")).not.toBeNull();
    await act(async () => reloadedRoot.unmount());
  });
});
