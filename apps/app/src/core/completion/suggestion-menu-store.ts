/**
 * The host-independent lifecycle for a menu the writer types underneath.
 *
 * A host opens one session, advances its generation before starting work, and
 * publishes an update only with the returned identity. Arrival order is thus
 * irrelevant: an update from an old generation or closed session is refused.
 * This owner also publishes the external-store snapshot, invokes host callbacks,
 * and keeps selection attached to a stable row ID across catalog refreshes.
 */

export type SuggestionSessionId = string;
export type SuggestionGeneration = Readonly<{
  sessionId: SuggestionSessionId;
  generation: number;
}>;
export type SuggestionSelectionPolicy = "reset" | "preserve-active";

/** The only key capability a suggestion host supplies to its adapter. */
export type KeyArbiter = {
  register: (input: {
    id: string;
    bindings: Readonly<Record<"ArrowDown" | "ArrowUp" | "Enter", () => boolean>>;
  }) => () => void;
};

export type SuggestionMenuSnapshot<TItem, TMeta = null> = {
  open: boolean;
  items: readonly TItem[];
  /** Stable identity of the highlighted row; array position is presentation only. */
  activeId: string | null;
  activeIndex: number;
  query: string;
  anchorRect: (() => DOMRect | null) | null;
  label: string;
  meta: TMeta | null;
};

export type SuggestionSession<TItem, TMeta = null> = {
  items: readonly TItem[];
  /** Stable within the row's domain, including across catalog refreshes. */
  rowId: (item: TItem) => string;
  query: string;
  anchorRect: () => DOMRect | null;
  label: string;
  meta: TMeta;
  choose: (item: TItem) => void;
  choosable?: (item: TItem) => boolean;
  dismiss: () => void;
};

export type SuggestionLifecycleCallbacks<TItem, TMeta = null> = {
  open?: (identity: SuggestionGeneration, snapshot: SuggestionMenuSnapshot<TItem, TMeta>) => void;
  update?: (identity: SuggestionGeneration, snapshot: SuggestionMenuSnapshot<TItem, TMeta>) => void;
  close?: (sessionId: SuggestionSessionId) => void;
};

export type SuggestionMenu<TItem, TMeta = null> = {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => SuggestionMenuSnapshot<TItem, TMeta>;
  setActiveId: (rowId: string) => void;
  setActiveIndex: (index: number) => void;
  move: (delta: number) => boolean;
  choose: (index: number) => boolean;
  chooseActive: () => boolean;
  dismiss: () => void;
};

/** The single session owner, driven by a trigger or another host. */
export type SuggestionLifecycle<TItem, TMeta = null> = {
  open: (session: SuggestionSession<TItem, TMeta>) => SuggestionGeneration;
  /** Fence all earlier work before starting an async query/context/container update. */
  nextGeneration: (sessionId: SuggestionSessionId) => SuggestionGeneration | null;
  /** Returns false without publishing when the identity is stale. */
  update: (
    identity: SuggestionGeneration,
    session: SuggestionSession<TItem, TMeta>,
    selection: SuggestionSelectionPolicy,
  ) => boolean;
  /** A stale host cannot close a newer session. */
  close: (sessionId: SuggestionSessionId) => boolean;
};

let nextSuggestionSession = 0;

const CLOSED = Object.freeze({
  open: false,
  items: Object.freeze([]),
  activeId: null,
  activeIndex: 0,
  query: "",
  anchorRect: null,
  label: "",
  meta: null,
});

export function closedSuggestionMenu<TItem, TMeta = null>(): SuggestionMenuSnapshot<TItem, TMeta> {
  return CLOSED as SuggestionMenuSnapshot<TItem, TMeta>;
}

export function createSuggestionLifecycle<TItem, TMeta = null>(
  callbacks: SuggestionLifecycleCallbacks<TItem, TMeta> = {},
): {
  menu: SuggestionMenu<TItem, TMeta>;
  lifecycle: SuggestionLifecycle<TItem, TMeta>;
} {
  const listeners = new Set<() => void>();
  let identity: SuggestionGeneration | null = null;
  let session: SuggestionSession<TItem, TMeta> | null = null;
  let activeId: string | null = null;
  let snapshot: SuggestionMenuSnapshot<TItem, TMeta> = closedSuggestionMenu();

  const indexOf = (rowId: string | null) =>
    rowId === null || !session
      ? -1
      : session.items.findIndex((item) => session?.rowId(item) === rowId);

  const choosable = (index: number) => {
    const item = session?.items[index];
    return item !== undefined && (session?.choosable?.(item) ?? true);
  };

  const firstChoosableId = () => {
    const count = session?.items.length ?? 0;
    for (let index = 0; index < count; index += 1) {
      const item = session?.items[index];
      if (item !== undefined && choosable(index)) return session?.rowId(item) ?? null;
    }
    return null;
  };

  const publish = () => {
    snapshot = session
      ? {
          open: session.items.length > 0,
          items: session.items,
          activeId,
          activeIndex: indexOf(activeId),
          query: session.query,
          anchorRect: session.anchorRect,
          label: session.label,
          meta: session.meta,
        }
      : closedSuggestionMenu();
    for (const listener of listeners) listener();
  };

  const menu: SuggestionMenu<TItem, TMeta> = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,
    setActiveId(rowId) {
      const index = indexOf(rowId);
      if (rowId === activeId || !choosable(index)) return;
      activeId = rowId;
      publish();
    },
    setActiveIndex(index) {
      const item = session?.items[index];
      if (item === undefined || !choosable(index)) return;
      menu.setActiveId(session?.rowId(item) ?? "");
    },
    move(delta) {
      const count = session?.items.length ?? 0;
      if (count === 0) return false;
      const activeIndex = indexOf(activeId);
      for (let step = 1; step <= count; step += 1) {
        const candidate = (((activeIndex + delta * step) % count) + count) % count;
        const item = session?.items[candidate];
        if (item === undefined || !choosable(candidate)) continue;
        activeId = session?.rowId(item) ?? null;
        publish();
        return true;
      }
      return false;
    },
    choose(index) {
      const item = session?.items[index];
      if (!session || item === undefined || !choosable(index)) return false;
      session.choose(item);
      return true;
    },
    chooseActive() {
      return menu.choose(indexOf(activeId));
    },
    dismiss() {
      session?.dismiss();
    },
  };

  const lifecycle: SuggestionLifecycle<TItem, TMeta> = {
    open(next) {
      if (identity) callbacks.close?.(identity.sessionId);
      session = next;
      identity = Object.freeze({
        sessionId: `suggestion-${++nextSuggestionSession}`,
        generation: 0,
      });
      activeId = firstChoosableId();
      publish();
      callbacks.open?.(identity, snapshot);
      return identity;
    },
    nextGeneration(sessionId) {
      if (!identity || identity.sessionId !== sessionId) return null;
      identity = Object.freeze({ sessionId, generation: identity.generation + 1 });
      return identity;
    },
    update(candidate, next, selection) {
      if (
        !identity ||
        candidate.sessionId !== identity.sessionId ||
        candidate.generation !== identity.generation
      ) {
        return false;
      }
      const previousActiveId = activeId;
      session = next;
      activeId =
        selection === "preserve-active" && choosable(indexOf(previousActiveId))
          ? previousActiveId
          : firstChoosableId();
      publish();
      callbacks.update?.(identity, snapshot);
      return true;
    },
    close(sessionId) {
      if (!identity || identity.sessionId !== sessionId) return false;
      session = null;
      identity = null;
      activeId = null;
      publish();
      callbacks.close?.(sessionId);
      return true;
    },
  };

  return { menu, lifecycle };
}
