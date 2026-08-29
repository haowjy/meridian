/** Authenticated-account scope for the context removal coordinator. */

import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useInsertionEffect, useMemo } from "react";
import { lookupProjectContextAvailability } from "@/client/query/project-context-availability";
import { getLiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { ContextRemovalCoordinator } from "./context-removal-coordinator";
import { ProjectContextAvailabilityCoordinator } from "./project-context-availability-coordinator";

const ContextRemovalAccountContext = createContext<ContextRemovalCoordinator | null>(null);
const ProjectAvailabilityAccountContext =
  createContext<ProjectContextAvailabilityCoordinator | null>(null);

export function ContextRemovalAccountProvider({
  accountId,
  children,
}: {
  accountId: string;
  children: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const lifetime = useMemo(() => {
    const registry = getLiveDocumentSessionRegistry();
    const removal = new ContextRemovalCoordinator(accountId, { sessions: registry });
    const availability = new ProjectContextAvailabilityCoordinator({
      lookup: lookupProjectContextAvailability,
      apply: (commands) => removal.reconcileDocumentAvailability(commands),
      repairProjectCatalog: (projectId) =>
        queryClient.invalidateQueries({ queryKey: ["projects", projectId, "context-catalog"] }),
    });
    return { registry, removal, availability, lease: removal.createLifetimeLease() };
  }, [accountId, queryClient]);
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
    const repair = () => void lifetime.availability.recheckWatchedProjects();
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
        lifetime.lease.disposeIfSuspended();
      });
    };
  }, [lifetime]);
  return (
    <ContextRemovalAccountContext.Provider value={lifetime.removal}>
      <ProjectAvailabilityAccountContext.Provider value={lifetime.availability}>
        {children}
      </ProjectAvailabilityAccountContext.Provider>
    </ContextRemovalAccountContext.Provider>
  );
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
