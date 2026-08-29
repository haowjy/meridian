import { describe, expect, it, vi } from "vitest";

import { createSuggestionLifecycle, type SuggestionSession } from "./suggestion-menu-store";

type Row = { id: string; blocked?: boolean; label?: string };
const ROWS: Row[] = [
  { id: "heading", blocked: true },
  { id: "quote" },
  { id: "table", blocked: true },
  { id: "code" },
];
const choosableRow = (item: Row) => item.blocked !== true;

function session(
  items: readonly Row[],
  overrides: Partial<SuggestionSession<Row>> = {},
): SuggestionSession<Row> {
  return {
    items,
    rowId: (row) => row.id,
    query: "",
    anchorRect: () => null,
    label: "Insert block",
    meta: null,
    choose: vi.fn(),
    dismiss: vi.fn(),
    ...overrides,
  };
}

function nextGeneration(
  lifecycle: ReturnType<typeof createSuggestionLifecycle<Row>>["lifecycle"],
  sessionId: string,
) {
  const generation = lifecycle.nextGeneration(sessionId);
  if (!generation) throw new Error("expected an active suggestion session");
  return generation;
}

describe("suggestion lifecycle", () => {
  it("publishes open, accepted update, and close through one callback boundary", () => {
    const callbacks = { open: vi.fn(), update: vi.fn(), close: vi.fn() };
    const { menu, lifecycle } = createSuggestionLifecycle<Row>(callbacks);
    const identity = lifecycle.open(session(ROWS));
    const generation = nextGeneration(lifecycle, identity.sessionId);

    expect(lifecycle.update(generation, session(ROWS.slice(1), { query: "q" }), "reset")).toBe(
      true,
    );
    expect(lifecycle.close(identity.sessionId)).toBe(true);
    expect(callbacks.open).toHaveBeenCalledWith(identity, expect.objectContaining({ open: true }));
    expect(callbacks.update).toHaveBeenCalledWith(
      generation,
      expect.objectContaining({ query: "q" }),
    );
    expect(callbacks.close).toHaveBeenCalledWith(identity.sessionId);
    expect(menu.snapshot().open).toBe(false);
  });

  it("resets selection for a query update but preserves stable identity on refresh", () => {
    const { menu, lifecycle } = createSuggestionLifecycle<Row>();
    const opened = lifecycle.open(session([{ id: "a" }, { id: "b" }, { id: "c" }]));
    menu.setActiveId("b");

    const queryGeneration = nextGeneration(lifecycle, opened.sessionId);
    lifecycle.update(
      queryGeneration,
      session([{ id: "c" }, { id: "b" }, { id: "a" }], { query: "new" }),
      "reset",
    );
    expect(menu.snapshot()).toMatchObject({ activeId: "c", activeIndex: 0 });

    menu.setActiveId("b");
    const refreshGeneration = nextGeneration(lifecycle, opened.sessionId);
    lifecycle.update(
      refreshGeneration,
      session([{ id: "c", label: "changed" }, { id: "a" }, { id: "b", label: "refreshed" }]),
      "preserve-active",
    );
    expect(menu.snapshot()).toMatchObject({ activeId: "b", activeIndex: 2 });
  });

  it("falls back to the first choosable row when a preserved row disappears", () => {
    const { menu, lifecycle } = createSuggestionLifecycle<Row>();
    const opened = lifecycle.open(session([{ id: "a" }, { id: "b" }]));
    menu.setActiveId("b");
    const generation = nextGeneration(lifecycle, opened.sessionId);
    lifecycle.update(
      generation,
      session([{ id: "blocked", blocked: true }, { id: "c" }], { choosable: choosableRow }),
      "preserve-active",
    );
    expect(menu.snapshot()).toMatchObject({ activeId: "c", activeIndex: 1 });
  });

  it("discards old generations and old sessions without publishing", () => {
    const { menu, lifecycle } = createSuggestionLifecycle<Row>();
    const first = lifecycle.open(session([{ id: "first" }]));
    const staleGeneration = nextGeneration(lifecycle, first.sessionId);
    const currentGeneration = nextGeneration(lifecycle, first.sessionId);
    const listener = vi.fn();
    menu.subscribe(listener);

    expect(lifecycle.update(staleGeneration, session([{ id: "stale" }]), "reset")).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(lifecycle.update(currentGeneration, session([{ id: "current" }]), "reset")).toBe(true);

    const second = lifecycle.open(session([{ id: "second" }]));
    listener.mockClear();
    expect(lifecycle.update(currentGeneration, session([{ id: "old" }]), "reset")).toBe(false);
    expect(lifecycle.close(first.sessionId)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(menu.snapshot().activeId).toBe("second");
    expect(second.sessionId).not.toBe(first.sessionId);
  });
});

describe("menu movement and choice", () => {
  it("steps over refusing rows and chooses by the active stable identity", () => {
    const choose = vi.fn();
    const { menu, lifecycle } = createSuggestionLifecycle<Row>();
    lifecycle.open(session(ROWS, { choose, choosable: choosableRow }));

    expect(menu.snapshot()).toMatchObject({ activeId: "quote", activeIndex: 1 });
    expect(menu.move(1)).toBe(true);
    expect(menu.snapshot()).toMatchObject({ activeId: "code", activeIndex: 3 });
    expect(menu.chooseActive()).toBe(true);
    expect(choose).toHaveBeenCalledWith(ROWS[3]);
  });

  it("hands keys back when every visible row refuses", () => {
    const { menu, lifecycle } = createSuggestionLifecycle<Row>();
    lifecycle.open(session([{ id: "heading", blocked: true }], { choosable: choosableRow }));
    expect(menu.snapshot()).toMatchObject({ open: true, activeId: null, activeIndex: -1 });
    expect(menu.move(1)).toBe(false);
    expect(menu.chooseActive()).toBe(false);
  });
});
