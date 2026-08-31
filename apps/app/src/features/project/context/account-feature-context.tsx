/** React projection of one supervisor-owned account feature lifetime. */
import {
  createContext,
  useContext,
  useEffect,
  useInsertionEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { PostApplyDispositionOwner } from "../draft-apply-recovery/draft-apply-recovery-owner";
import type {
  AccountFeatureDeclaration,
  AccountFeatureLifetime,
  AccountFeatureSupervisor,
} from "./account-feature-supervisor";
import type { ContextRemovalCoordinator } from "./context-removal-coordinator";
import type { LocalUntitledOwner } from "./local-untitled-owner";
import type { ProjectContextAvailabilityCoordinator } from "./project-context-availability-coordinator";
import { ProjectDocumentLiveOpenerContext } from "./project-document-live-opener-context";

export const AccountFeatureSupervisorContext = createContext<AccountFeatureSupervisor | null>(null);
const ContextRemovalAccountContext = createContext<ContextRemovalCoordinator | null>(null);
const ProjectAvailabilityAccountContext =
  createContext<ProjectContextAvailabilityCoordinator | null>(null);
const LocalUntitledAccountContext = createContext<LocalUntitledOwner | null>(null);
const LiveDocumentRegistryAccountContext = createContext<AccountFeatureLifetime["registry"] | null>(
  null,
);
const PostApplyOwnerAccountContext = createContext<PostApplyDispositionOwner | null>(null);

export function AccountFeatureComposition({
  authSubject,
  accountId,
  repairProjectCatalog,
  children,
}: {
  authSubject: string;
  accountId: string;
  repairProjectCatalog: (projectId: string) => Promise<void>;
  children: React.ReactNode;
}) {
  const supervisor = useContext(AccountFeatureSupervisorContext);
  if (!supervisor) throw new Error("AccountFeatureSupervisorProvider is required");
  const snapshot = useSyncExternalStore(
    supervisor.subscribe,
    supervisor.getSnapshot,
    supervisor.getServerSnapshot,
  );
  const declarationRef = useRef<AccountFeatureDeclaration | null>(null);
  const auth = supervisor.getAuthDeclaration();
  if (
    declarationRef.current &&
    (declarationRef.current.auth.subject !== authSubject ||
      declarationRef.current.account.id !== accountId)
  ) {
    declarationRef.current = null;
  }
  if (!declarationRef.current && auth?.subject === authSubject) {
    declarationRef.current = Object.freeze({ auth, account: Object.freeze({ id: accountId }) });
  }
  const declaration = declarationRef.current;
  const lifetime =
    snapshot.kind === "ready" &&
    declaration !== null &&
    snapshot.declaration.auth.epoch === declaration.auth.epoch &&
    snapshot.declaration.auth.subject === declaration.auth.subject &&
    snapshot.declaration.account.id === declaration.account.id
      ? snapshot.lifetime
      : null;
  const [attached, setAttached] = useState<AccountFeatureLifetime | null>(null);

  useEffect(() => {
    if (declaration) supervisor.declareAccount(declaration);
  }, [supervisor, declaration]);

  useEffect(() => {
    if (!lifetime) {
      setAttached(null);
      return;
    }
    let attachment: ReturnType<AccountFeatureLifetime["attachComposition"]>;
    try {
      attachment = lifetime.attachComposition(repairProjectCatalog);
    } catch {
      setAttached(null);
      return;
    }
    setAttached(lifetime);
    return () => {
      setAttached(null);
      attachment.release();
    };
  }, [lifetime, repairProjectCatalog]);

  if (!lifetime || attached !== lifetime) {
    return (
      <main className="grid min-h-svh place-items-center bg-background text-foreground">
        <p>Preparing your workspace…</p>
      </main>
    );
  }
  return <AccountFeatureProviders lifetime={lifetime}>{children}</AccountFeatureProviders>;
}
function AccountFeatureProviders({
  lifetime,
  children,
}: {
  lifetime: AccountFeatureLifetime;
  children: React.ReactNode;
}) {
  useInsertionEffect(() => {
    lifetime.resumeFeatureLease();
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
      lifetime.suspendFeatureLease();
    };
  }, [lifetime]);
  return (
    <ContextRemovalAccountContext.Provider value={lifetime.removal}>
      <ProjectAvailabilityAccountContext.Provider value={lifetime.availability}>
        <LocalUntitledAccountContext.Provider value={lifetime.localOwner}>
          <LiveDocumentRegistryAccountContext.Provider value={lifetime.registry}>
            <ProjectDocumentLiveOpenerContext.Provider value={lifetime.opener}>
              <PostApplyOwnerAccountContext.Provider value={lifetime.postApplyOwner}>
                {children}
              </PostApplyOwnerAccountContext.Provider>
            </ProjectDocumentLiveOpenerContext.Provider>
          </LiveDocumentRegistryAccountContext.Provider>
        </LocalUntitledAccountContext.Provider>
      </ProjectAvailabilityAccountContext.Provider>
    </ContextRemovalAccountContext.Provider>
  );
}

export function useLocalUntitledOwner(): LocalUntitledOwner {
  const owner = useContext(LocalUntitledAccountContext);
  if (!owner) throw new Error("AccountFeatureComposition is required");
  return owner;
}

export { useProjectDocumentLiveOpener } from "./project-document-live-opener-context";

export function useProjectContextAvailabilityCoordinator(): ProjectContextAvailabilityCoordinator {
  const coordinator = useContext(ProjectAvailabilityAccountContext);
  if (!coordinator) throw new Error("AccountFeatureComposition is required");
  return coordinator;
}

export function useContextRemovalCoordinator(): ContextRemovalCoordinator {
  const coordinator = useContext(ContextRemovalAccountContext);
  if (!coordinator) throw new Error("AccountFeatureComposition is required");
  return coordinator;
}

export function useLiveDocumentSessionRegistry(): AccountFeatureLifetime["registry"] {
  const registry = useContext(LiveDocumentRegistryAccountContext);
  if (!registry) throw new Error("AccountFeatureComposition is required");
  return registry;
}

export function useAccountPostApplyDispositionOwner(): PostApplyDispositionOwner {
  const owner = useContext(PostApplyOwnerAccountContext);
  if (!owner) throw new Error("AccountFeatureComposition is required");
  return owner;
}

export function useOptionalProjectContextAvailabilityCoordinator(): ProjectContextAvailabilityCoordinator | null {
  return useContext(ProjectAvailabilityAccountContext);
}
