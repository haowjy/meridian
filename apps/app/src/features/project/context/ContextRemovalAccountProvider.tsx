/** Authenticated-account scope for the context removal coordinator. */

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
  const lifetime = useMemo(() => {
    const removal = new ContextRemovalCoordinator(accountId, {
      sessions: getLiveDocumentSessionRegistry(),
    });
    const availability = new ProjectContextAvailabilityCoordinator({
      lookup: lookupProjectContextAvailability,
      apply: async (commands) => {
        await removal.reconcileDocumentAvailability(commands);
      },
    });
    return { removal, availability, lease: removal.createLifetimeLease() };
  }, [accountId]);
  useInsertionEffect(() => {
    lifetime.lease.resume();
    return () => {
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
