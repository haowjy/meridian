/** Authenticated-account scope for the context removal coordinator. */

import { createContext, useContext, useInsertionEffect, useMemo } from "react";
import { lookupProjectContextAvailability } from "@/client/query/project-context-availability";
import { createAccountDocumentSessionRuntime } from "@/core/editor/account-document-session-runtime";
import { ContextRemovalCoordinator } from "./context-removal-coordinator";
import { LocalUntitledOwner } from "./local-untitled-owner";
import { BrowserLocalUntitledRecordStore } from "./local-untitled-record-store";
import { ProjectDocumentLiveOpener } from "./open-project-document";
import { ProjectContextAvailabilityCoordinator } from "./project-context-availability-coordinator";

const ContextRemovalAccountContext = createContext<ContextRemovalCoordinator | null>(null);
const NOOP_CATALOG_REPAIR = async () => undefined;

const ProjectAvailabilityAccountContext =
  createContext<ProjectContextAvailabilityCoordinator | null>(null);
const LocalUntitledAccountContext = createContext<LocalUntitledOwner | null>(null);
const ProjectDocumentLiveOpenerContext = createContext<ProjectDocumentLiveOpener | null>(null);

export function ContextRemovalAccountProvider({
  accountId,
  repairProjectCatalog = NOOP_CATALOG_REPAIR,
  children,
}: {
  accountId: string;
  repairProjectCatalog?: (projectId: string) => Promise<void>;
  children: React.ReactNode;
}) {
  const lifetime = useMemo(() => {
    const runtime = createAccountDocumentSessionRuntime({ accountId });
    const registry = runtime.registry;
    const removal = new ContextRemovalCoordinator(accountId, { sessions: registry });
    const availability = new ProjectContextAvailabilityCoordinator({
      lookup: lookupProjectContextAvailability,
      apply: (commands) => removal.reconcileDocumentAvailability(commands),
      repairProjectCatalog,
    });
    const storage =
      typeof window === "undefined"
        ? ({
            length: 0,
            getItem: () => null,
            setItem: () => undefined,
            removeItem: () => undefined,
            clear: () => undefined,
            key: () => null,
          } as Storage)
        : window.localStorage;
    const localOwner = new LocalUntitledOwner({
      accountId,
      records: new BrowserLocalUntitledRecordStore(storage),
      lifetime: runtime.localLifetime,
      sessions: runtime.localConstruction,
      reservations: runtime.localReservation,
    });
    const opener = new ProjectDocumentLiveOpener({
      availability,
      registry,
      adoption: runtime.localAdoption,
      epochSignal: runtime.epochSignal,
    });
    return {
      runtime,
      registry,
      removal,
      availability,
      localOwner,
      opener,
      lease: removal.createLifetimeLease(),
    };
  }, [accountId, repairProjectCatalog]);
  useInsertionEffect(() => {
    lifetime.lease.resume();
    const retainedLeases = new Map<
      string,
      { lease: ReturnType<typeof lifetime.availability.attachProject>; documentIds: string[] }
    >();
    const stopRetained = lifetime.registry.observeRetainedLiveDocuments((snapshot) => {
      const byProject = new Map<string, string[]>();
      for (const reference of snapshot) {
        const ids = byProject.get(reference.projectId) ?? [];
        ids.push(reference.documentId);
        byProject.set(reference.projectId, ids);
      }
      for (const [projectId, retained] of retainedLeases) {
        if (byProject.has(projectId)) continue;
        retained.lease.release();
        retainedLeases.delete(projectId);
      }
      for (const [projectId, documentIds] of byProject) {
        let retained = retainedLeases.get(projectId);
        if (!retained) {
          retained = { lease: lifetime.availability.attachProject(projectId), documentIds: [] };
          retainedLeases.set(projectId, retained);
        }
        retained.documentIds = documentIds;
        retained.lease.watch(
          "retained-sessions",
          documentIds.map((documentId) => ({ documentId })),
        );
      }
    });
    const repair = () =>
      void Promise.all([
        lifetime.availability.recheckWatchedProjects(),
        lifetime.removal.retryPendingSessionEffects(),
      ]);
    window.addEventListener("focus", repair);
    window.addEventListener("online", repair);
    const poll = window.setInterval(repair, 60_000);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener("focus", repair);
      window.removeEventListener("online", repair);
      stopRetained();
      for (const retained of retainedLeases.values()) retained.lease.release();
      lifetime.lease.suspend();
      queueMicrotask(() => {
        if (!lifetime.lease.disposeIfSuspended()) return;
        lifetime.runtime.beginClose();
        void lifetime.localOwner
          .destroyAll()
          .then(() => lifetime.runtime.finishClose())
          .catch(() => undefined);
      });
    };
  }, [lifetime]);
  return (
    <ContextRemovalAccountContext.Provider value={lifetime.removal}>
      <ProjectAvailabilityAccountContext.Provider value={lifetime.availability}>
        <LocalUntitledAccountContext.Provider value={lifetime.localOwner}>
          <ProjectDocumentLiveOpenerContext.Provider value={lifetime.opener}>
            {children}
          </ProjectDocumentLiveOpenerContext.Provider>
        </LocalUntitledAccountContext.Provider>
      </ProjectAvailabilityAccountContext.Provider>
    </ContextRemovalAccountContext.Provider>
  );
}

export function useLocalUntitledOwner(): LocalUntitledOwner {
  const owner = useContext(LocalUntitledAccountContext);
  if (!owner) throw new Error("ContextRemovalAccountProvider is required");
  return owner;
}

export function useProjectDocumentLiveOpener(): ProjectDocumentLiveOpener {
  const opener = useContext(ProjectDocumentLiveOpenerContext);
  if (!opener) throw new Error("ContextRemovalAccountProvider is required");
  return opener;
}

export function useProjectContextAvailabilityCoordinator(): ProjectContextAvailabilityCoordinator {
  const coordinator = useContext(ProjectAvailabilityAccountContext);
  if (!coordinator) throw new Error("ContextRemovalAccountProvider is required");
  return coordinator;
}

export function useContextRemovalCoordinator(): ContextRemovalCoordinator {
  const coordinator = useContext(ContextRemovalAccountContext);
  if (!coordinator) throw new Error("ContextRemovalAccountProvider is required");
  return coordinator;
}
