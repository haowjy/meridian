/** Browser adapters and React bindings for the durable untitled reconciler engine. */

import { useSyncExternalStore } from "react";
import { createUntitledContextDocument } from "@/client/api/projects-api";
import { lookupProjectContextAvailability } from "@/client/query/project-context-availability";
import { lookupContextCatalogFile } from "@/client/query/useContextCatalog";
import { useContextTabsStore } from "@/client/stores";
import {
  getDocumentSessionRegistry,
  getLiveDocumentSessionRegistry,
} from "@/core/editor/document-session-registry";
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
  localOwner?: LocalUntitledOwner,
  opener?: ProjectDocumentLiveOpener,
): UntitledReconcilerDeps {
  const registry = getDocumentSessionRegistry();
  const liveRegistry = getLiveDocumentSessionRegistry();
  const localKey = (projectId: string, documentId: string) => ({
    accountId: localOwner?.dependencies.accountId ?? "",
    projectId,
    documentId,
  });
  return {
    storage: localStorage,
    scheduler: {
      queue: (task) => queueMicrotask(task),
      setTimer: (task, delayMs) => setTimeout(task, delayMs),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      onOnline: (task) => {
        window.addEventListener("online", task);
        return () => window.removeEventListener("online", task);
      },
    },
    sessions: {
      getDetached: registry.getDetached,
      retain: registry.retain,
      release: registry.release,
      destroyRoom: registry.destroyRoom,
      admit: (projectId, documentId, generation) =>
        liveRegistry.admit(projectId, documentId, generation),
      attachDetached: (lease) => liveRegistry.attachDetached(lease),
      restartUnavailableRoom: (lease) => liveRegistry.restartUnavailableRoom(lease),
      retainAdmitted: (owner, leases) => liveRegistry.retain(owner, leases),
      releaseAdmitted: (owner) => liveRegistry.release(owner),
    },
    newDocumentId: () => crypto.randomUUID(),
    ...(localOwner && opener
      ? {
          localOwner: {
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
              localOwner.dependencies.records.read(localKey(projectId, documentId))?.phase ?? null,
          },
        }
      : {}),
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
      async serverDocumentExists(entry) {
        return Boolean(
          await lookupContextCatalogFile(entry.projectId, entry.home.scheme, entry.home.workId, {
            entryId: entry.documentId,
          }),
        );
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
  if (!shared && typeof window !== "undefined" && identityMutations) {
    shared = new UntitledReconciler(browserDeps(identityMutations, localOwner, opener));
  }
  if (!shared) throw new Error("Untitled reconciler is browser-only");
  return shared;
}

export function registerUntitledCandidate(
  documentId: string,
  candidate: Parameters<UntitledReconciler["registerCandidate"]>[1],
): () => void {
  return getUntitledReconciler().registerCandidate(documentId, candidate);
}

export function syncUntitledReceiptOwners(): void {
  const referencedDocumentIds = new Set(
    Object.values(useContextTabsStore.getState().byProject).flatMap((desk) =>
      desk.tabs.map((tab) => tab.documentId),
    ),
  );
  getUntitledReconciler().setMaterializationReceiptOwners(referencedDocumentIds);
}

export function appendPendingUntitled(entry: PendingUntitled): void {
  getUntitledReconciler().append(entry);
  // The new tab is opened before this append. Flush after the reconciler has
  // made it eligible for desk persistence so a same-tick reload cannot lose it.
}

export function isUntitledPending(documentId: string): boolean {
  return getUntitledReconciler().has(documentId);
}

export function useUntitledPending(documentId: string): boolean {
  const reconciler = typeof window === "undefined" ? null : getUntitledReconciler();
  return useSyncExternalStore(
    reconciler?.subscribe ?? noopSubscribe,
    () => reconciler?.has(documentId) ?? false,
    () => false,
  );
}

export function useUntitledPendingSince(documentId: string): number | null {
  const reconciler = typeof window === "undefined" ? null : getUntitledReconciler();
  return useSyncExternalStore(
    reconciler?.subscribe ?? noopSubscribe,
    () => reconciler?.pendingSince(documentId) ?? null,
    () => null,
  );
}

export function useQueuedIdentityFailure(documentId: string): QueuedIdentityFailure | null {
  const reconciler = typeof window === "undefined" ? null : getUntitledReconciler();
  return useSyncExternalStore(
    reconciler?.subscribe ?? noopSubscribe,
    () => reconciler?.queuedIdentityFailure(documentId) ?? null,
    () => null,
  );
}

export function clearQueuedIdentityFailure(documentId: string): void {
  getUntitledReconciler().clearQueuedIdentityFailure(documentId);
}

export function queueUntitledIdentity(entry: PendingUntitled, desired: DesiredIdentity): void {
  getUntitledReconciler().queueIdentity(entry, desired);
}
