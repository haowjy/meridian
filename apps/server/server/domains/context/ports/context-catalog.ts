/** Domain ports for durable catalog reads, mutation refresh, and lossy wake hints. */
import type {
  CatalogChanges,
  CatalogChildrenRequest,
  CatalogChildrenResult,
  CatalogLookupRequest,
  CatalogLookupResult,
  CatalogScope,
  CatalogSnapshot,
  CatalogWakeHint,
} from "@meridian/contracts/protocol";

export interface ContextCatalog {
  snapshot(scope: CatalogScope): Promise<CatalogSnapshot>;
  changes(scope: CatalogScope, cursor: string, limit?: number): Promise<CatalogChanges>;
  children(input: CatalogChildrenRequest): Promise<CatalogChildrenResult>;
  lookup(input: CatalogLookupRequest): Promise<CatalogLookupResult>;
}

export interface ContextCatalogMutationPort {
  /** Reconcile authoritative rows for each affected source in the ambient transaction. */
  refreshSources(
    sourceIds: readonly string[],
    invalidatedRootIds?: readonly string[],
  ): Promise<string>;
  /** Reconcile project authority entries after a Work/project lifecycle mutation. */
  refreshProject(projectId: string): Promise<void>;
}

export interface ContextCatalogWakePort {
  publish(hint: CatalogWakeHint): void | Promise<void>;
}
