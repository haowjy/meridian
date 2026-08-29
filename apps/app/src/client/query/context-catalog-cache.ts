/** One normalized, transactional metadata cache shared by every catalog projection. */
import type {
  CatalogChanges,
  CatalogCommit,
  CatalogEntry,
  CatalogScope,
  CatalogSnapshot,
} from "@meridian/contracts/protocol";
import { catalogScopeKey } from "@meridian/contracts/protocol";

export type CatalogCacheView = {
  scope: CatalogScope;
  generation: string;
  headRevision: string;
  cursor: string;
  entries: ReadonlyMap<string, CatalogEntry>;
  invalidatedEntryIds: ReadonlySet<string>;
};

function emptyView(scope: CatalogScope): CatalogCacheView {
  return {
    scope,
    generation: "",
    headRevision: "0",
    cursor: "",
    entries: new Map(),
    invalidatedEntryIds: new Set(),
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

/**
 * Mutable cache boundary. Mutations prepare fresh maps before publishing, so a
 * rejected or partial commit can never leak into projections.
 */
export class ContextCatalogCache {
  private readonly scopes = new Map<string, CatalogCacheView>();
  private readonly appliedEvents = new Map<string, Set<string>>();

  read(scope: CatalogScope): CatalogCacheView {
    return this.scopes.get(catalogScopeKey(scope)) ?? emptyView(scope);
  }

  replace(snapshot: CatalogSnapshot): CatalogCacheView {
    const key = catalogScopeKey(snapshot.scope);
    const next: CatalogCacheView = {
      scope: snapshot.scope,
      generation: snapshot.generation,
      headRevision: snapshot.headRevision,
      cursor: snapshot.cursor,
      entries: new Map(snapshot.entries.map((entry) => [entry.entryId, entry])),
      invalidatedEntryIds: new Set(),
    };
    this.scopes.set(key, next);
    this.appliedEvents.set(key, new Set());
    return next;
  }

  apply(changes: CatalogChanges): CatalogCacheView | null {
    if (changes.kind === "reset-required") return null;
    const key = catalogScopeKey(changes.scope);
    const current = this.read(changes.scope);
    const seen = new Set(this.appliedEvents.get(key));
    let next = current;
    for (const commit of changes.commits) {
      if (seen.has(commit.eventId)) continue;
      const applied = applyCommit(next, commit);
      next = {
        ...next,
        entries: applied.entries,
        invalidatedEntryIds: applied.invalidatedEntryIds,
        headRevision: commit.lastRevision,
      };
      seen.add(commit.eventId);
    }
    next = { ...next, cursor: changes.nextCursor, headRevision: changes.headRevision };
    this.scopes.set(key, next);
    this.appliedEvents.set(key, seen);
    return next;
  }
}

export function catalogChildren(view: CatalogCacheView, parentId: string): CatalogEntry[] {
  return [...view.entries.values()]
    .filter(
      (entry) =>
        (entry.kind === "folder" || entry.kind === "file") &&
        entry.parentId === parentId &&
        !view.invalidatedEntryIds.has(entry.entryId),
    )
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
      return left.name.localeCompare(right.name) || left.entryId.localeCompare(right.entryId);
    });
}

export function catalogFiles(view: CatalogCacheView): CatalogEntry[] {
  return [...view.entries.values()].filter(
    (entry) => entry.kind === "file" && !view.invalidatedEntryIds.has(entry.entryId),
  );
}
