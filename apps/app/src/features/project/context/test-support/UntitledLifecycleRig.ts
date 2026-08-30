/**
 * Stateful runtime for exercising untitled materialization and identity moves.
 *
 * The rig owns storage, scheduling, sessions, API outcomes, and callback
 * journals. Tests configure boundary outcomes, advance the scheduler, and
 * query reconciliation state rather than coordinating independent mocks.
 */

import type {
  CreateUntitledContextDocumentResponse,
  CreateUntitledContextDocumentResult,
  MoveContextEntryResult,
  MoveContextEntrySuccess,
} from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import * as Y from "yjs";
import type { moveContextEntry } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { type ContextTab, useContextTabsStore } from "@/client/stores";
import type { DocumentSessionSnapshot } from "@/core/editor/document-session";
import type { LocalDocumentSessionHandoff } from "@/core/editor/local-document-session-adoption";
import { createContextIdentityMutationService } from "../context-identity-mutation";
import type { DesiredIdentity } from "../identity-location";
import type { LocalUntitledRecord } from "../local-untitled-record-store";
import {
  type PendingUntitled,
  type ReconciliationRecord,
  type UntitledHome,
  UntitledReconciler,
  type UntitledReconcilerDeps,
} from "../untitled-reconciler";

export const UNTITLED_HOME = { scheme: "scratch", workId: "work-1" } as const;
export const UNTITLED_TAB: ContextTab = {
  kind: "tracked",
  documentId: "doc-1",
  scheme: "scratch",
  path: "/Untitled.md",
  name: "Untitled.md",
  workId: "work-1",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
  provisionalName: true,
};

type AsyncHandler<Args extends unknown[], Result> = (...args: Args) => Promise<Result>;

class OutcomePlan<Args extends unknown[], Result> {
  readonly calls: Args[] = [];
  private readonly handlers: Array<AsyncHandler<Args, Result>> = [];

  constructor(private fallback: AsyncHandler<Args, Result>) {}

  enqueueResult(...results: Result[]): void {
    for (const result of results) this.handlers.push(async () => result);
  }

  enqueueError(...errors: unknown[]): void {
    for (const error of errors) {
      this.handlers.push(async () => {
        throw error;
      });
    }
  }

  enqueueHandler(handler: AsyncHandler<Args, Result>): void {
    this.handlers.push(handler);
  }

  setFallback(handler: AsyncHandler<Args, Result>): void {
    this.fallback = handler;
  }

  run = async (...args: Args): Promise<Result> => {
    this.calls.push(args);
    return (this.handlers.shift() ?? this.fallback)(...args);
  };
}

export type LifecycleGate<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
};

export function lifecycleGate<T>(): LifecycleGate<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

export function documentWithText(text = "words"): Y.Doc {
  const document = new Y.Doc();
  if (text) {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText(text)]);
    document.getXmlFragment("prosemirror").insert(0, [paragraph]);
  }
  return document;
}

export class LifecycleSession {
  readonly document: Y.Doc;
  readonly fragmentName = "prosemirror" as const;
  localSyncCount = 0;
  durableSyncCount = 0;
  persistenceFlushCount = 0;

  private status: DocumentSessionSnapshot["status"] = "synced";
  private localSync = async () => {};
  private durableSync = async () => {};
  private persistenceFlush = async () => {};

  constructor(document = documentWithText()) {
    this.document = document;
  }

  getSnapshot = (): DocumentSessionSnapshot => ({ status: this.status }) as DocumentSessionSnapshot;

  whenLocalPersistenceSynced = async (): Promise<void> => {
    this.localSyncCount += 1;
    await this.localSync();
  };

  waitForDurableSync = async (): Promise<void> => {
    this.durableSyncCount += 1;
    await this.durableSync();
  };

  flushLocalPersistence = async (): Promise<void> => {
    this.persistenceFlushCount += 1;
    await this.persistenceFlush();
  };

  setStatus(status: DocumentSessionSnapshot["status"]): void {
    this.status = status;
  }

  waitForLocalSync(gate: LifecycleGate<void>): void {
    this.localSync = () => gate.promise;
  }

  waitForDurable(gate: LifecycleGate<void>): void {
    this.durableSync = () => gate.promise;
  }

  waitForPersistenceFlush(gate: LifecycleGate<void>): void {
    this.persistenceFlush = () => gate.promise;
  }
}

type ResolvedEntry = PendingUntitled & { home: UntitledHome };
type MoveSource = CreateUntitledContextDocumentResponse;

export class UntitledLifecycleRig {
  readonly queryClient = new QueryClient();
  readonly storage = new Map<string, string>();
  readonly durableRecords = new Map<string, LocalUntitledRecord>();
  readonly queued: Array<() => void> = [];
  readonly timers: Array<() => void> = [];
  readonly onlineListeners = new Set<() => void>();
  readonly sessions = new Map<string, LifecycleSession>();
  readonly clearedRooms: string[] = [];
  readonly restartedRooms: string[] = [];
  readonly lifecycleEvents: string[] = [];
  readonly materialized: CreateUntitledContextDocumentResponse[] = [];
  readonly identities: MoveContextEntrySuccess[] = [];
  readonly reminted: string[] = [];

  readonly home = new OutcomePlan<[string], UntitledHome | null>(async () => UNTITLED_HOME);
  readonly create = new OutcomePlan<[ResolvedEntry], CreateUntitledContextDocumentResult>(
    async (entry) => ({
      status: "created",
      documentId: entry.documentId,
      scheme: "scratch",
      path: "/Untitled",
      name: "Untitled",
    }),
  );
  readonly exists = new OutcomePlan<[ResolvedEntry], boolean>(async () => false);
  readonly move = new OutcomePlan<
    [ResolvedEntry, MoveSource, DesiredIdentity],
    MoveContextEntryResult
  >(async () => ({
    status: "moved",
    scheme: "manuscript",
    path: "Act 1/Opening.md",
    name: "Opening.md",
  }));
  readonly identityMove = new OutcomePlan<
    Parameters<typeof moveContextEntry>,
    Awaited<ReturnType<typeof moveContextEntry>>
  >(async () => ({
    status: "moved",
    scheme: "manuscript",
    path: "Act 1/Opening.md",
    name: "Opening.md",
  }));
  readonly identityMutations = createContextIdentityMutationService(
    this.queryClient,
    this.identityMove.run,
  );

  readonly deps: UntitledReconcilerDeps;
  reconciler: UntitledReconciler;
  nextDocumentId = "replacement";
  destroyRoomError: Error | null = null;

  constructor() {
    const durableKey = (projectId: string, documentId: string) => `${projectId}:${documentId}`;
    const reservations = new Map<string, LocalDocumentSessionHandoff>();
    const ensureRecord = (projectId: string, documentId: string) => {
      const key = durableKey(projectId, documentId);
      let record = this.durableRecords.get(key);
      if (!record) {
        record = {
          key: { accountId: "account-1", projectId, documentId },
          lineageId: documentId,
          revision: 1,
          phase: "local-pending",
          home: null,
          pendingSinceMs: null,
        };
        this.durableRecords.set(key, record);
        this.session(documentId);
      }
      return record;
    };
    this.deps = {
      scheduler: {
        queue: (task) => this.queued.push(task),
        setTimer: (task) => {
          this.timers.push(task);
          return task;
        },
        clearTimer: (timer) => {
          const index = this.timers.indexOf(timer as () => void);
          if (index >= 0) this.timers.splice(index, 1);
        },
        onOnline: (task) => {
          this.onlineListeners.add(task);
          return () => this.onlineListeners.delete(task);
        },
      },
      api: {
        resolveHome: this.home.run,
        create: this.create.run,
        serverDocumentExists: this.exists.run,
        move: this.move.run,
        lookupGeneration: async (_projectId, documentId) => {
          this.lifecycleEvents.push(`lookup:${documentId}`);
          return "1";
        },
      },
      localOwner: {
        list: () => [...this.durableRecords.values()],
        read: (projectId, documentId) => ensureRecord(projectId, documentId),
        write: (record) =>
          this.durableRecords.set(durableKey(record.key.projectId, record.key.documentId), record),
        remove: (projectId, documentId) => {
          this.durableRecords.delete(durableKey(projectId, documentId));
        },
        get: (_projectId, documentId) => this.sessions.get(documentId) ?? null,
        restore: async (_projectId, documentId) => ({
          session: this.session(documentId),
          documentId,
        }),
        retain: () => undefined,
        release: () => undefined,
        revision: (projectId, documentId) =>
          this.durableRecords.get(durableKey(projectId, documentId))?.revision ?? null,
        prepare: async (projectId, documentId) => {
          const handoff = Object.freeze({}) as LocalDocumentSessionHandoff;
          reservations.set(durableKey(projectId, documentId), handoff);
          return handoff;
        },
        abort: (projectId, documentId, handoff) => {
          if (reservations.get(durableKey(projectId, documentId)) === handoff) {
            reservations.delete(durableKey(projectId, documentId));
          }
        },
        open: async (input) => {
          const session = this.session(input.documentId);
          const record = this.durableRecords.get(durableKey(input.projectId, input.documentId));
          if (record && input.source === "local-untitled") {
            this.durableRecords.set(durableKey(input.projectId, input.documentId), {
              ...record,
              phase: "adopted-live",
            });
            reservations.delete(durableKey(input.projectId, input.documentId));
          }
          this.lifecycleEvents.push(`admit:${input.documentId}`);
          if (session.getSnapshot().status === "access-lost") {
            this.lifecycleEvents.push(`restart:${input.documentId}`);
            this.restartedRooms.push(input.documentId);
            session.setStatus("detached");
          }
          this.lifecycleEvents.push(`attach:${input.documentId}`);
          if (session.getSnapshot().status === "detached") session.setStatus("synced");
          return {
            kind: "opened" as const,
            document: {} as never,
            admission: {
              projectId: input.projectId,
              documentId: input.documentId,
              generation: "1",
              bind: async () => ({
                projectId: input.projectId,
                documentId: input.documentId,
                generation: "1",
                session: session as never,
                release: () => undefined,
              }),
            },
          };
        },
        remint: async (projectId, from, to) => {
          const session = this.session(from);
          const current = this.durableRecords.get(durableKey(projectId, from));
          if (!current) throw new Error("missing durable record");
          reservations.delete(durableKey(projectId, from));
          this.sessions.delete(from);
          this.sessions.set(to, session);
          this.durableRecords.set(durableKey(projectId, from), { ...current, active: false });
          this.durableRecords.set(durableKey(projectId, to), {
            ...current,
            key: { ...current.key, documentId: to },
            revision: current.revision + 1,
            active: true,
          });
          reservations.set(
            durableKey(projectId, to),
            Object.freeze({}) as LocalDocumentSessionHandoff,
          );
          if (this.destroyRoomError) throw this.destroyRoomError;
          this.clearedRooms.push(from);
          return session;
        },
        abandon: async (projectId, documentId) => {
          this.durableRecords.delete(durableKey(projectId, documentId));
          this.sessions.delete(documentId);
        },
        phase: (projectId, documentId) =>
          this.durableRecords.get(durableKey(projectId, documentId))?.phase ?? null,
      },
      newDocumentId: () => this.nextDocumentId,
    };
    this.reconciler = new UntitledReconciler(this.deps);
  }

  seedTab(tab: ContextTab = UNTITLED_TAB, projectId = "project-1"): ContextTab {
    const workId = tab.workId ?? "work-1";
    useContextTabsStore.setState({
      byProject: {
        [projectId]: { tabs: [tab], selectedTabIdByWork: { [workId]: tab.documentId } },
      },
    });
    return tab;
  }

  seedRecord(record: ReconciliationRecord, projectId = "project-1"): void {
    const entry = record.materialization.phase === "pending" ? record.materialization.entry : null;
    this.durableRecords.set(`${projectId}:${record.documentId}`, {
      key: { accountId: "account-1", projectId, documentId: record.documentId },
      lineageId: record.documentId,
      revision: 1,
      workRevision: record.revision,
      phase: record.materialization.phase === "pending" ? "local-pending" : "adopted-live",
      home: entry?.home ?? null,
      desiredIdentity: record.desiredIdentity,
      materializedResult: record.materializedResult,
      failure: record.failure,
      pendingSinceMs: record.pendingSinceMs,
    });
    this.session(record.documentId);
  }

  seedTree(projectId: string, scheme: "manuscript" | "scratch", workId?: string): void {
    this.queryClient.setQueryData(
      projectQueryKeys.contextCatalogView(projectId, scheme, workId),
      {},
    );
  }

  treeInvalidated(projectId: string, scheme: "manuscript" | "scratch", workId?: string): boolean {
    return Boolean(
      this.queryClient.getQueryState(projectQueryKeys.contextCatalogView(projectId, scheme, workId))
        ?.isInvalidated,
    );
  }

  session(documentId: string, text = "words"): LifecycleSession {
    let session = this.sessions.get(documentId);
    if (!session) {
      session = new LifecycleSession(documentWithText(text));
      this.sessions.set(documentId, session);
    }
    return session;
  }

  replaceSession(documentId: string, session: LifecycleSession): void {
    this.sessions.set(documentId, session);
  }

  start(): void {
    this.reconciler.start();
  }

  restart(): void {
    // Browser disposal cannot retract a microtask already handed to the
    // scheduler. Keep that stale callback so restart scenarios prove the
    // disposed reconciler cannot mutate the rehydrated lifecycle.
    this.reconciler.dispose();
    this.reconciler = new UntitledReconciler(this.deps);
    this.reconciler.start();
  }

  trackCandidate(documentId: string): void {
    this.reconciler.registerCandidate(documentId, {
      onReminted: (id) => this.reminted.push(id),
      onMaterialized: ({ result, identity }) => {
        this.materialized.push(result);
        if (identity) this.identities.push(identity);
      },
    });
  }

  append(documentId: string, options: { projectId?: string; withHome?: boolean } = {}): void {
    const projectId = options.projectId ?? "project-1";
    const key = `${projectId}:${documentId}`;
    if (!this.durableRecords.has(key)) {
      this.durableRecords.set(key, {
        key: { accountId: "account-1", projectId, documentId },
        lineageId: documentId,
        revision: 1,
        phase: "local-pending",
        home: null,
        pendingSinceMs: null,
      });
    }
    this.session(documentId);
    this.reconciler.append({
      documentId,
      projectId,
      ...(options.withHome === false ? {} : { home: UNTITLED_HOME }),
    });
  }

  queueIdentity(documentId: string, name: string, folderPath = "Act 1"): void {
    const key = `project-1:${documentId}`;
    if (!this.durableRecords.has(key)) {
      this.durableRecords.set(key, {
        key: { accountId: "account-1", projectId: "project-1", documentId },
        lineageId: documentId,
        revision: 1,
        phase: "local-pending",
        home: UNTITLED_HOME,
        pendingSinceMs: Date.now(),
      });
      this.session(documentId);
    }
    this.reconciler.queueIdentity(
      { documentId, projectId: "project-1", home: UNTITLED_HOME },
      { name, destination: { scheme: "manuscript", folderPath } },
    );
  }

  async advance(): Promise<void> {
    this.queued.shift()?.();
    for (let index = 0; index < 40; index += 1) await Promise.resolve();
  }

  async retry(): Promise<void> {
    this.timers.shift()?.();
    await this.advance();
  }

  notifyOnline(): void {
    for (const listener of this.onlineListeners) listener();
  }

  records(): ReconciliationRecord[] {
    return [...this.durableRecords.values()]
      .filter((record) => record.active !== false)
      .map((record) => ({
        documentId: record.key.documentId,
        revision: record.workRevision ?? record.revision,
        materialization:
          record.phase === "local-pending"
            ? {
                phase: "pending" as const,
                entry: {
                  documentId: record.key.documentId,
                  projectId: record.key.projectId,
                  ...(record.home ? { home: record.home } : {}),
                },
              }
            : { phase: "synced" as const },
        desiredIdentity: record.desiredIdentity,
        materializedResult: record.materializedResult,
        failure: record.failure,
        pendingSinceMs: record.pendingSinceMs ?? null,
      }));
  }
}
