/** Account-owned project-final identity coordinator and deterministic drain core. */
import type {
  AvailabilityCommandId,
  AvailabilityGeneration,
  CatalogFileEntry,
  ProjectContextAuthority,
  ProjectContextIdentityLookupResult,
  ProjectContextIdentityResolution,
} from "@meridian/contracts/protocol";

export type ProjectDocumentAvailabilityCommand =
  | {
      kind: "available";
      commandId: AvailabilityCommandId;
      projectId: string;
      document: CatalogFileEntry;
      generation: AvailabilityGeneration;
    }
  | {
      kind: "terminal-remove";
      commandId: AvailabilityCommandId;
      projectId: string;
      documentId: string;
      generation: AvailabilityGeneration;
      cause: "document-deleted";
    }
  | {
      kind: "authority-revoke";
      commandId: AvailabilityCommandId;
      projectId: string;
      documentId: string;
      generation: AvailabilityGeneration;
      authority: ProjectContextAuthority;
      cause: "authority-unavailable" | "no-longer-visible";
    };

export type InstalledCatalogObservation = {
  projectId: string;
  vanishedDocumentIds: readonly string[];
  changedWatchedDocumentIds: readonly string[];
};

type Lookup = (
  projectId: string,
  documentIds: readonly string[],
) => Promise<ProjectContextIdentityLookupResult>;

type WatchRecord = { documentId: string; workId?: string };
type ProjectState = {
  leases: number;
  watches: Map<string, ReadonlyMap<string, WatchRecord>>;
  requestGeneration: Map<string, number>;
  highestAuthorityGeneration: Map<string, bigint>;
  admittedAuthority: Map<string, ProjectContextAuthority>;
  inFlight: number;
  slotWaiters: Array<() => void>;
  indeterminateHandlers: Map<string, () => void | Promise<void>>;
};

export type ProjectAvailabilityLease = {
  watch(producer: string, documentIds: readonly string[], options?: { workId?: string }): void;
  release(): void;
};

const MAX_IDS = 128;
const MAX_ATTEMPTS = 2;

function authorityGeneration(resolution: ProjectContextIdentityResolution): string {
  return resolution.kind === "not-visible" || resolution.kind === "indeterminate"
    ? resolution.checkedGeneration
    : resolution.generation;
}

function commandId(
  kind: ProjectDocumentAvailabilityCommand["kind"],
  projectId: string,
  documentId: string,
  generation: string,
): AvailabilityCommandId {
  return `availability/v1/${kind}/${projectId}/${documentId}/${generation}`;
}

export class ProjectContextAvailabilityCoordinator {
  private readonly projects = new Map<string, ProjectState>();
  private nextLeaseId = 0;

  constructor(
    private readonly dependencies: {
      lookup: Lookup;
      apply(commands: readonly ProjectDocumentAvailabilityCommand[]): void | Promise<void>;
      retryDelayMs?: number;
      onIndeterminate?: (projectId: string, documentId: string) => void;
    },
  ) {}

  attachProject(
    projectId: string,
    options: { onIndeterminate?: () => void | Promise<void> } = {},
  ): ProjectAvailabilityLease {
    const state = this.project(projectId);
    state.leases += 1;
    const prefix = `lease:${++this.nextLeaseId}:`;
    if (options.onIndeterminate) state.indeterminateHandlers.set(prefix, options.onIndeterminate);
    let held = true;
    return {
      watch: (producer, documentIds, options) => {
        if (!held) return;
        state.watches.set(
          `${prefix}${producer}`,
          new Map(
            [...new Set(documentIds)].map((documentId) => [
              documentId,
              { documentId, ...(options?.workId ? { workId: options.workId } : {}) },
            ]),
          ),
        );
      },
      release: () => {
        if (!held) return;
        held = false;
        for (const key of state.watches.keys())
          if (key.startsWith(prefix)) state.watches.delete(key);
        state.indeterminateHandlers.delete(prefix);
        state.leases -= 1;
        if (state.leases === 0) this.projects.delete(projectId);
      },
    };
  }

  async observe(observation: InstalledCatalogObservation): Promise<void> {
    const ids = [...observation.vanishedDocumentIds, ...observation.changedWatchedDocumentIds];
    await this.recheck(observation.projectId, ids);
  }

  async coldScopeHint(projectId: string, workId: string): Promise<void> {
    const state = this.projects.get(projectId);
    if (!state) return;
    const ids = this.watchedRecords(state)
      .filter((record) => record.workId === workId)
      .map((record) => record.documentId);
    if (ids.length > 0) await this.recheck(projectId, ids);
  }

  watchedDocumentIds(projectId: string): string[] {
    const state = this.projects.get(projectId);
    return state
      ? this.watchedRecords(state)
          .map((record) => record.documentId)
          .sort()
      : [];
  }

  async recheck(projectId: string, candidateIds?: readonly string[]): Promise<void> {
    const state = this.projects.get(projectId);
    if (!state) return;
    const watched = new Set(this.watchedRecords(state).map((record) => record.documentId));
    const ids = [...new Set(candidateIds ?? [...watched])].filter((id) => watched.has(id)).sort();
    if (ids.length === 0) return;
    const localGenerations = new Map<string, number>();
    for (const documentId of ids) {
      const next = (state.requestGeneration.get(documentId) ?? 0) + 1;
      state.requestGeneration.set(documentId, next);
      localGenerations.set(documentId, next);
    }
    const chunks: string[][] = [];
    for (let index = 0; index < ids.length; index += MAX_IDS)
      chunks.push(ids.slice(index, index + MAX_IDS));
    const commands: ProjectDocumentAvailabilityCommand[] = [];
    let unresolved = false;
    let nonsupersededCount = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < chunks.length) {
        const chunk = chunks[cursor++];
        if (!chunk) return;
        let response: ProjectContextIdentityLookupResult | null = null;
        for (let attempt = 0; attempt < MAX_ATTEMPTS && !response; attempt += 1) {
          try {
            response = await this.withLookupSlot(state, () =>
              this.dependencies.lookup(projectId, chunk),
            );
          } catch {
            if (attempt + 1 < MAX_ATTEMPTS && this.dependencies.retryDelayMs) {
              await new Promise((resolve) => setTimeout(resolve, this.dependencies.retryDelayMs));
            }
          }
        }
        if (!response) {
          unresolved = true;
          continue;
        }
        const byId = new Map(
          response.resolutions.map((resolution) => [resolution.documentId, resolution]),
        );
        if (byId.size !== chunk.length || chunk.some((id) => !byId.has(id))) {
          unresolved = true;
          continue;
        }
        for (const documentId of chunk) {
          if (state.requestGeneration.get(documentId) !== localGenerations.get(documentId))
            continue;
          nonsupersededCount += 1;
          const resolution = byId.get(documentId) as ProjectContextIdentityResolution;
          const settled =
            resolution.kind === "indeterminate"
              ? await this.retryIndeterminate(projectId, documentId, state)
              : resolution;
          if (!settled) continue;
          const generation = BigInt(authorityGeneration(settled));
          if (generation < (state.highestAuthorityGeneration.get(documentId) ?? -1n)) continue;
          const command = this.classify(projectId, settled, state);
          state.highestAuthorityGeneration.set(documentId, generation);
          if (command) commands.push(command);
        }
      }
    };
    await Promise.all([worker(), worker()]);
    if (
      !unresolved &&
      nonsupersededCount > 0 &&
      this.projects.get(projectId) === state &&
      state.leases > 0
    ) {
      commands.sort((left, right) => left.commandId.localeCompare(right.commandId));
      await this.dependencies.apply(commands);
    }
  }

  private classify(
    projectId: string,
    resolution: ProjectContextIdentityResolution,
    state: ProjectState,
  ): ProjectDocumentAvailabilityCommand | null {
    const documentId = resolution.documentId;
    if (resolution.kind === "available") {
      state.admittedAuthority.set(documentId, resolution.authority);
      return {
        kind: "available",
        projectId,
        document: resolution.entry,
        generation: resolution.generation,
        commandId: commandId("available", projectId, documentId, resolution.generation),
      };
    }
    if (resolution.kind === "deleted") {
      return {
        kind: "terminal-remove",
        projectId,
        documentId,
        generation: resolution.generation,
        cause: "document-deleted",
        commandId: commandId("terminal-remove", projectId, documentId, resolution.generation),
      };
    }
    if (resolution.kind === "authority-unavailable") {
      return {
        kind: "authority-revoke",
        projectId,
        documentId,
        generation: resolution.generation,
        authority: resolution.authority,
        cause: "authority-unavailable",
        commandId: commandId("authority-revoke", projectId, documentId, resolution.generation),
      };
    }
    if (resolution.kind === "not-visible") {
      const authority = state.admittedAuthority.get(documentId);
      if (!authority) return null;
      return {
        kind: "authority-revoke",
        projectId,
        documentId,
        generation: resolution.checkedGeneration,
        authority,
        cause: "no-longer-visible",
        commandId: commandId(
          "authority-revoke",
          projectId,
          documentId,
          resolution.checkedGeneration,
        ),
      };
    }
    return null;
  }

  private watchedRecords(state: ProjectState): WatchRecord[] {
    const records = new Map<string, WatchRecord>();
    for (const watch of state.watches.values())
      for (const record of watch.values()) records.set(record.documentId, record);
    return [...records.values()];
  }

  private async withLookupSlot<T>(state: ProjectState, run: () => Promise<T>): Promise<T> {
    if (state.inFlight >= 2) await new Promise<void>((resolve) => state.slotWaiters.push(resolve));
    state.inFlight += 1;
    try {
      return await run();
    } finally {
      state.inFlight -= 1;
      state.slotWaiters.shift()?.();
    }
  }

  private async retryIndeterminate(
    projectId: string,
    documentId: string,
    state: ProjectState,
  ): Promise<ProjectContextIdentityResolution | null> {
    this.dependencies.onIndeterminate?.(projectId, documentId);
    await Promise.all([...state.indeterminateHandlers.values()].map((handler) => handler()));
    try {
      const retry = await this.withLookupSlot(state, () =>
        this.dependencies.lookup(projectId, [documentId]),
      );
      const resolution = retry.resolutions[0];
      return resolution &&
        resolution.documentId === documentId &&
        resolution.kind !== "indeterminate"
        ? resolution
        : null;
    } catch {
      return null;
    }
  }

  private project(projectId: string): ProjectState {
    let state = this.projects.get(projectId);
    if (!state) {
      state = {
        leases: 0,
        watches: new Map(),
        requestGeneration: new Map(),
        highestAuthorityGeneration: new Map(),
        admittedAuthority: new Map(),
        inFlight: 0,
        slotWaiters: [],
        indeterminateHandlers: new Map(),
      };
      this.projects.set(projectId, state);
    }
    return state;
  }
}
