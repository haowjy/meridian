/** Browser adapters and React bindings for the durable untitled reconciler engine. */

import { useSyncExternalStore } from "react";
import { createUntitledContextDocument } from "@/client/api/projects-api";
import { lookupProjectContextAvailability } from "@/client/query/project-context-availability";
import { lookupContextCatalogFile } from "@/client/query/useContextCatalog";
import { useContextTabsStore } from "@/client/stores";
import type { ContextIdentityMutationService } from "./context-identity-mutation";
import type { DesiredIdentity } from "./identity-location";
import type { LocalUntitledOwner } from "./local-untitled-owner";
import { LocalUntitledIdentityRedirect } from "./local-untitled-owner";
import type { ProjectDocumentLiveOpener } from "./open-project-document";
import {
  type PendingUntitled,
  type QueuedIdentityFailure,
  resolveUntitledHome,
  UntitledReconciler,
  type UntitledReconcilerDeps,
} from "./untitled-reconciler";

function browserDeps(
  identityMutations: ContextIdentityMutationService,
  localOwner: LocalUntitledOwner,
  opener: ProjectDocumentLiveOpener,
): UntitledReconcilerDeps {
  const localKey = (projectId: string, documentId: string) => ({
    accountId: localOwner.accountId,
    projectId,
    documentId,
  });
  return {
    scheduler: {
      queue: (task) => queueMicrotask(task),
      setTimer: (task, delayMs) => setTimeout(task, delayMs),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      onOnline: (task) => {
        window.addEventListener("online", task);
        return () => window.removeEventListener("online", task);
      },
    },
    newDocumentId: () => crypto.randomUUID(),
    localOwner: {
      accountId: localOwner.accountId,
      list: () => localOwner.listWork(),
      read: (projectId, documentId) => localOwner.readWork(localKey(projectId, documentId)),
      write: (record) => localOwner.writeWork(record),
      remove(projectId, documentId, expectedRevision) {
        const result = localOwner.removeWork(localKey(projectId, documentId), expectedRevision);
        if (result !== "removed") throw new Error("Local Untitled work revision is stale");
      },
      get: (projectId: string, documentId: string) =>
        localOwner.getDetached(localKey(projectId, documentId))?.session ?? null,
      async restore(projectId: string, documentId: string) {
        let result: Awaited<ReturnType<LocalUntitledOwner["restore"]>>;
        try {
          result = await localOwner.restore(localKey(projectId, documentId));
        } catch (error) {
          if (!(error instanceof LocalUntitledIdentityRedirect)) throw error;
          result = await localOwner.restore(error.key);
        }
        if (result.kind !== "opened")
          throw new Error("Local Untitled is owned in another browser tab");
        return {
          session: result.value.session,
          documentId: result.value.key.documentId,
        };
      },
      retain(ownerId: string, projectId: string, documentId: string) {
        localOwner.retain(ownerId, [localKey(projectId, documentId)]);
      },
      release: (ownerId: string) => localOwner.release(ownerId),
      revision: (projectId: string, documentId: string) =>
        localOwner.recordRevision(localKey(projectId, documentId)),
      prepare: (projectId: string, documentId: string, revision: number) =>
        localOwner.prepareMaterialization(localKey(projectId, documentId), revision),
      abort: (projectId, documentId, handoff) =>
        localOwner.abortMaterialization(localKey(projectId, documentId), handoff),
      open: (input) =>
        input.source === "local-untitled" && input.handoff
          ? opener.open({ ...input, source: "local-untitled", handoff: input.handoff })
          : opener.open({
              source: "server",
              projectId: input.projectId,
              documentId: input.documentId,
            }),
      async remint(projectId: string, from: string, to: string) {
        return (await localOwner.remint(localKey(projectId, from), localKey(projectId, to)))
          .session;
      },
      async abandon(projectId: string, documentId: string, revision: number) {
        const result = await localOwner.abandon({
          key: localKey(projectId, documentId),
          expectedRevision: revision,
          evidence: "server-row-absent",
        });
        if (result !== "abandoned") throw new Error(`Local abandon was ${result}`);
      },
      phase: (projectId: string, documentId: string) =>
        localOwner.phase(localKey(projectId, documentId)),
    },
    api: {
      resolveHome: resolveUntitledCatalogHome,
      async create(entry) {
        const result = await createUntitledContextDocument(
          entry.projectId,
          entry.home.scheme,
          {
            documentId: entry.documentId,
            ...(entry.home.folderPath ? { folderPath: entry.home.folderPath } : {}),
          },
          { workId: entry.home.workId },
        );
        if (result.status !== "conflict") {
          await identityMutations.materialized(entry.projectId, result);
        }
        return result;
      },
      async confirmCreate(entry) {
        const file = await lookupContextCatalogFile(
          entry.projectId,
          entry.home.scheme,
          entry.home.workId,
          { entryId: entry.documentId },
        );
        if (!file) return { status: "definite-no-row" };
        const result = {
          status: "already-materialized" as const,
          documentId: entry.documentId,
          scheme: entry.home.scheme,
          path: file.path.startsWith("/") ? file.path : `/${file.path}`,
          name: file.name,
          workId: entry.home.workId,
        };
        await identityMutations.materialized(entry.projectId, result);
        return {
          status: "present",
          result,
        };
      },
      async move(entry, source, desired: DesiredIdentity) {
        const { result } = await identityMutations.move(
          entry.documentId,
          entry.projectId,
          {
            scheme: source.scheme,
            path: source.path,
            ...(source.workId ? { workId: source.workId } : {}),
          },
          desired,
        );
        return result;
      },
      async lookupGeneration(projectId, documentId) {
        const result = await lookupProjectContextAvailability(projectId, [documentId]);
        const resolution = result.resolutions[0];
        if (resolution?.kind !== "available") {
          throw new Error("Materialized Untitled is not authoritatively available");
        }
        return resolution.generation;
      },
    },
  };
}

export async function resolveUntitledCatalogHome(_projectId: string) {
  return resolveUntitledHome(null);
}

let shared: UntitledReconciler | null = null;
const accountReconcilers = new WeakMap<LocalUntitledOwner, UntitledReconciler>();
const noopSubscribe = () => () => {};

export function getUntitledReconciler(
  identityMutations?: ContextIdentityMutationService,
  localOwner?: LocalUntitledOwner,
  opener?: ProjectDocumentLiveOpener,
): UntitledReconciler {
  if (localOwner && identityMutations && opener && typeof window !== "undefined") {
    let account = accountReconcilers.get(localOwner);
    if (!account) {
      account = new UntitledReconciler(browserDeps(identityMutations, localOwner, opener));
      accountReconcilers.set(localOwner, account);
    }
    shared = account;
    return account;
  }
  if (!shared) throw new Error("Untitled reconciler is browser-only");
  return shared;
}

export function registerUntitledCandidate(
  projectId: string,
  documentId: string,
  candidate: Parameters<UntitledReconciler["registerCandidate"]>[2],
): () => void {
  return getUntitledReconciler().registerCandidate(projectId, documentId, candidate);
}

export function syncUntitledReceiptOwners(): void {
  const referencedEntries = Object.entries(useContextTabsStore.getState().byProject).flatMap(
    ([projectId, desk]) => desk.tabs.map((tab) => ({ projectId, documentId: tab.documentId })),
  );
  getUntitledReconciler().setMaterializationReceiptOwners(referencedEntries);
}

export function appendPendingUntitled(entry: PendingUntitled): void {
  getUntitledReconciler().append(entry);
  // The new tab is opened before this append. Flush after the reconciler has
  // made it eligible for desk persistence so a same-tick reload cannot lose it.
}

export function isUntitledPending(projectId: string, documentId: string): boolean {
  return getUntitledReconciler().has(projectId, documentId);
}

export function useUntitledPending(projectId: string, documentId: string): boolean {
  const reconciler = typeof window === "undefined" ? null : getUntitledReconciler();
  return useSyncExternalStore(
    reconciler?.subscribe ?? noopSubscribe,
    () => reconciler?.has(projectId, documentId) ?? false,
    () => false,
  );
}

export function useUntitledPendingSince(projectId: string, documentId: string): number | null {
  const reconciler = typeof window === "undefined" ? null : getUntitledReconciler();
  return useSyncExternalStore(
    reconciler?.subscribe ?? noopSubscribe,
    () => reconciler?.pendingSince(projectId, documentId) ?? null,
    () => null,
  );
}

export function useQueuedIdentityFailure(
  projectId: string,
  documentId: string,
): QueuedIdentityFailure | null {
  const reconciler = typeof window === "undefined" ? null : getUntitledReconciler();
  return useSyncExternalStore(
    reconciler?.subscribe ?? noopSubscribe,
    () => reconciler?.queuedIdentityFailure(projectId, documentId) ?? null,
    () => null,
  );
}

export function clearQueuedIdentityFailure(projectId: string, documentId: string): void {
  getUntitledReconciler().clearQueuedIdentityFailure(projectId, documentId);
}

export function queueUntitledIdentity(entry: PendingUntitled, desired: DesiredIdentity): void {
  getUntitledReconciler().queueIdentity(entry, desired);
}
