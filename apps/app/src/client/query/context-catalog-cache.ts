/** One normalized, transactional metadata cache shared by every catalog projection. */
import type {
  CatalogChanges,
  CatalogCommit,
  CatalogEntry,
  CatalogScope,
  CatalogSnapshot,
} from "@meridian/contracts/protocol";

export type CatalogCacheView = {
  scope: CatalogScope;
  generation: string;
  headRevision: string;
  cursor: string;
  entries: ReadonlyMap<string, CatalogEntry>;
  invalidatedEntryIds: ReadonlySet<string>;
  childIdsByParentId: ReadonlyMap<string, readonly string[]>;
  sourceIdsByScheme: ReadonlyMap<string, string>;
};

export function emptyCatalogView(scope: CatalogScope): CatalogCacheView {
  return {
    scope,
    generation: "",
    headRevision: "0",
    cursor: "",
    entries: new Map(),
    invalidatedEntryIds: new Set(),
    childIdsByParentId: new Map(),
    sourceIdsByScheme: new Map(),
  };
}

function descendants(entries: ReadonlyMap<string, CatalogEntry>, rootId: string): Set<string> {
  const invalid = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries.values()) {
      if (
        (entry.kind === "folder" || entry.kind === "file") &&
        invalid.has(entry.parentId) &&
        !invalid.has(entry.entryId)
      ) {
        invalid.add(entry.entryId);
        changed = true;
      }
    }
  }
  return invalid;
}

function applyCommit(
  current: CatalogCacheView,
  commit: CatalogCommit,
): Pick<CatalogCacheView, "entries" | "invalidatedEntryIds"> {
  const entries = new Map(current.entries);
  const invalidated = new Set(current.invalidatedEntryIds);
  const changes = [...commit.changes].sort((a, b) => a.ordinal - b.ordinal);
  for (const change of changes) {
    if (change.operation === "upsert") {
      entries.set(change.entry.entryId, change.entry);
      invalidated.delete(change.entry.entryId);
      continue;
    }
    if (change.operation === "delete") {
      entries.delete(change.entryId);
      invalidated.delete(change.entryId);
      continue;
    }
    for (const entryId of descendants(entries, change.rootEntryId)) invalidated.add(entryId);
  }
  return { entries, invalidatedEntryIds: invalidated };
}

function withIndexes(
  view: Omit<CatalogCacheView, "childIdsByParentId" | "sourceIdsByScheme">,
): CatalogCacheView {
  const childIdsByParentId = new Map<string, string[]>();
  const sourceIdsByScheme = new Map<string, string>();
  for (const entry of view.entries.values()) {
    if (entry.kind === "source") sourceIdsByScheme.set(entry.scheme, entry.entryId);
    if (entry.kind !== "folder" && entry.kind !== "file") continue;
    const ids = childIdsByParentId.get(entry.parentId) ?? [];
    ids.push(entry.entryId);
    childIdsByParentId.set(entry.parentId, ids);
  }
  for (const ids of childIdsByParentId.values()) {
    ids.sort((leftId, rightId) => {
      const left = view.entries.get(leftId);
      const right = view.entries.get(rightId);
      if (!left || !right) return leftId.localeCompare(rightId);
      if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
      return left.name.localeCompare(right.name) || left.entryId.localeCompare(right.entryId);
    });
  }
  return { ...view, childIdsByParentId, sourceIdsByScheme };
}

export function catalogViewFromSnapshot(snapshot: CatalogSnapshot): CatalogCacheView {
  return withIndexes({
    scope: snapshot.scope,
    generation: snapshot.generation,
    headRevision: snapshot.headRevision,
    cursor: snapshot.cursor,
    entries: new Map(snapshot.entries.map((entry) => [entry.entryId, entry])),
    invalidatedEntryIds: new Set(),
  });
}

/** Apply complete commit groups to the immutable React Query cache value. */
export function applyCatalogChanges(
  current: CatalogCacheView,
  changes: CatalogChanges,
): CatalogCacheView | null {
  if (changes.kind === "reset-required") return null;
  let next = current;
  for (const commit of changes.commits) {
    if (BigInt(commit.lastRevision) <= BigInt(next.headRevision)) continue;
    const applied = applyCommit(next, commit);
    next = {
      ...next,
      entries: applied.entries,
      invalidatedEntryIds: applied.invalidatedEntryIds,
      headRevision: commit.lastRevision,
    };
  }
  return withIndexes({
    scope: next.scope,
    generation: next.generation,
    cursor: changes.nextCursor,
    headRevision: changes.headRevision,
    entries: next.entries,
    invalidatedEntryIds: next.invalidatedEntryIds,
  });
}

export function catalogChildren(view: CatalogCacheView, parentId: string): CatalogEntry[] {
  return (view.childIdsByParentId.get(parentId) ?? []).flatMap((entryId) => {
    const entry = view.entries.get(entryId);
    return entry && !view.invalidatedEntryIds.has(entryId) ? [entry] : [];
  });
}

export function catalogFiles(view: CatalogCacheView): CatalogEntry[] {
  return [...view.entries.values()].filter(
    (entry) => entry.kind === "file" && !view.invalidatedEntryIds.has(entry.entryId),
  );
}
