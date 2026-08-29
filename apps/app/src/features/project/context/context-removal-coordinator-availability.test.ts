/** Existing-owner integration for project-final availability command batches. */
import type {
  CatalogFileEntry,
  LiveDocumentSessionAuthority,
  WorkingSetRoute,
} from "@meridian/contracts/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import type { ProjectSearch } from "../routing/project-route";
import { ContextRemovalCoordinator } from "./context-removal-coordinator";

const projectId = "project-1";
const documentId = "00000000-0000-4000-8000-000000000001";

function file(): CatalogFileEntry {
  return {
    kind: "file",
    entryId: documentId,
    scope: { kind: "work", projectId, workId: "work-2" },
    sourceId: "00000000-0000-4000-8000-000000000010",
    parentId: "00000000-0000-4000-8000-000000000010",
    name: "Moved.md",
    aliases: [],
    path: ["Arc", "Moved.md"],
    uri: "scratch://@work-2/Arc/Moved.md",
    provisionalName: false,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  };
}

describe("ContextRemovalCoordinator availability batches", () => {
  beforeEach(() => {
    useContextTabsStore.setState({
      byProject: {
        [projectId]: {
          tabs: [
            {
              kind: "tracked",
              documentId,
              scheme: "scratch",
              path: "Old.md",
              name: "Old.md",
              workId: "work-1",
              editable: true,
              filetype: "markdown",
              schemaType: "document",
            },
            {
              kind: "tracked",
              documentId,
              scheme: "scratch",
              path: "Copy.md",
              name: "Copy.md",
              workId: "work-1",
              editable: true,
              filetype: "markdown",
              schemaType: "document",
              draftOnly: true,
            },
          ],
          selectedTabIdByWork: { "work-1": documentId },
        },
      },
      _deskHydrated: true,
    });
  });

  it("re-homes every matching tab and the bound desktop/mobile route without changing active Work", async () => {
    let search: ProjectSearch = {
      screen: "context",
      scheme: "scratch",
      path: "Old.md",
      work: "work-1",
    };
    const route = {
      readSearch: () => search,
      updateSearch: (_projectId: string, update: (value: ProjectSearch) => ProjectSearch) => {
        search = update(search);
      },
    };
    const sessions = {
      revokeDocument: vi.fn(),
      revokeAccess: vi.fn(),
    } as unknown as LiveDocumentSessionAuthority;
    const coordinator = new ContextRemovalCoordinator("account-1", { route, sessions });
    coordinator.registerRoutePort(projectId, route, "work-1");
    const revision = coordinator.beginRouteSelection(projectId, {
      scheme: "scratch",
      path: "Old.md",
      workId: "work-1",
    });
    coordinator.bindRouteSelection(projectId, revision, { kind: "server", documentId });

    await coordinator.reconcileDocumentAvailability([
      {
        kind: "available",
        commandId: `availability/v1/available/${projectId}/${documentId}/7`,
        projectId,
        document: file(),
        generation: "7",
      },
    ]);

    expect(useContextTabsStore.getState().byProject[projectId]?.tabs).toEqual([
      expect.objectContaining({
        documentId,
        path: "Arc/Moved.md",
        workId: "work-2",
        name: "Moved.md",
      }),
    ]);
    expect(search).toEqual(expect.objectContaining({ work: "work-2", path: "Arc/Moved.md" }));
    expect(coordinator.getProjectSnapshot(projectId).selection).toEqual(
      expect.objectContaining({
        status: "bound",
        locator: { scheme: "scratch", path: "Arc/Moved.md", workId: "work-2" },
      }),
    );
    expect(sessions.revokeDocument).not.toHaveBeenCalled();

    const noWork = {
      ...file(),
      scope: { kind: "project" as const, projectId },
      uri: "scratch://@/Arc/Unscoped.md",
      path: ["Arc", "Unscoped.md"],
      name: "Unscoped.md",
    };
    coordinator.reconcileDocumentAvailability([
      {
        kind: "available",
        commandId: `availability/v1/available/${projectId}/${documentId}/8`,
        projectId,
        document: noWork,
        generation: "8",
      },
    ]);
    expect(useContextTabsStore.getState().byProject[projectId]?.tabs).toEqual([
      expect.not.objectContaining({ workId: expect.anything() }),
    ]);
    expect(coordinator.getProjectSnapshot(projectId).selection).toMatchObject({
      locator: { workId: null, path: "Arc/Unscoped.md" },
    });
    expect(coordinator.getProjectSnapshot(projectId).activeWorkId).toBe("work-1");
  });

  it("keeps access revoke distinct from terminal deletion and rejects stale generations", async () => {
    const sessions = {
      revokeDocument: vi.fn(async () => ({ revokedThrough: "9", persistence: "cleared" })),
      revokeAccess: vi.fn(async () => ({ revokedThrough: "8", persistence: "cleared" })),
    } as unknown as LiveDocumentSessionAuthority;
    const coordinator = new ContextRemovalCoordinator("account-1", { sessions });
    await coordinator.reconcileDocumentAvailability([
      {
        kind: "authority-revoke",
        commandId: `availability/v1/authority-revoke/${projectId}/${documentId}/8`,
        projectId,
        documentId,
        generation: "8",
        authority: { kind: "project", projectId },
        cause: "authority-unavailable",
      },
    ]).sessionSettlement;
    await coordinator.reconcileDocumentAvailability([
      {
        kind: "terminal-remove",
        commandId: `availability/v1/terminal-remove/${projectId}/${documentId}/9`,
        projectId,
        documentId,
        generation: "9",
        cause: "document-deleted",
      },
    ]).sessionSettlement;
    coordinator.reconcileDocumentAvailability([
      {
        kind: "available",
        commandId: `availability/v1/available/${projectId}/${documentId}/7`,
        projectId,
        document: file(),
        generation: "7",
      },
    ]);
    expect(sessions.revokeAccess).toHaveBeenCalledOnce();
    expect(sessions.revokeDocument).toHaveBeenCalledOnce();
    expect(useContextTabsStore.getState().byProject[projectId]?.tabs).toEqual([]);
  });

  it("does not install terminal reentry evidence for an authority revoke", async () => {
    const sessions = {
      revokeDocument: vi.fn(),
      revokeAccess: vi.fn(async () => ({ revokedThrough: "8", persistence: "cleared" })),
    } as unknown as LiveDocumentSessionAuthority;
    const coordinator = new ContextRemovalCoordinator("account-1", { sessions });
    const locator = { scheme: "scratch" as const, path: "Old.md", workId: "work-1" };
    const revision = coordinator.beginRouteSelection(projectId, locator);
    coordinator.bindRouteSelection(projectId, revision, { kind: "server", documentId });
    await coordinator.reconcileDocumentAvailability([
      {
        kind: "authority-revoke",
        commandId: `availability/v1/authority-revoke/${projectId}/${documentId}/8`,
        projectId,
        documentId,
        generation: "8",
        authority: { kind: "project", projectId },
        cause: "authority-unavailable",
      },
    ]);
    coordinator.beginRouteSelection(projectId, locator);
    expect(coordinator.getProjectSnapshot(projectId).selection).toEqual(
      expect.objectContaining({ status: "candidate", reentryGuard: null }),
    );
  });
});

describe("availability owner batch publication and settlement", () => {
  it("reuses routed-removal continuity and publishes only the adjacent final state", async () => {
    const adjacentId = "00000000-0000-4000-8000-000000000002";
    useContextTabsStore.setState({
      byProject: {
        [projectId]: {
          tabs: [
            {
              kind: "tracked",
              documentId,
              scheme: "manuscript",
              path: "Active.md",
              name: "Active.md",
              editable: true,
              filetype: "markdown",
              schemaType: "document",
            },
            {
              kind: "tracked",
              documentId: adjacentId,
              scheme: "manuscript",
              path: "Adjacent.md",
              name: "Adjacent.md",
              editable: true,
              filetype: "markdown",
              schemaType: "document",
            },
          ],
          selectedTabIdByWork: { "work-1": documentId },
        },
      },
      _deskHydrated: true,
    });
    let search: ProjectSearch = {
      screen: "context",
      scheme: "manuscript",
      path: "Active.md",
      work: "work-1",
    };
    let routes: WorkingSetRoute[] = [
      { documentId, scheme: "manuscript" as const, path: "Active.md" },
      { documentId: adjacentId, scheme: "manuscript" as const, path: "Adjacent.md" },
    ];
    const route = {
      readSearch: () => search,
      updateSearch: (_projectId: string, update: (value: ProjectSearch) => ProjectSearch) => {
        search = update(search);
      },
    };
    const coordinator = new ContextRemovalCoordinator("account-1", {
      route,
      workingSet: {
        readRecentRoutes: () => routes,
        replaceRecentRoutes: (_projectId, next) => {
          routes = [...next];
          return routes;
        },
        reconcileContextRoutes: () => routes,
      },
    });
    coordinator.registerRoutePort(projectId, route, "work-1");
    const revision = coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "Active.md",
      workId: "work-1",
    });
    coordinator.bindRouteSelection(projectId, revision, { kind: "server", documentId });
    const publications: string[][] = [];
    const stop = useContextTabsStore.subscribe((state) => {
      publications.push(state.byProject[projectId]?.tabs.map((tab) => tab.documentId) ?? []);
    });

    coordinator.reconcileDocumentAvailability([
      {
        kind: "terminal-remove",
        commandId: `availability/v1/terminal-remove/${projectId}/${documentId}/8`,
        projectId,
        documentId,
        generation: "8",
        cause: "document-deleted",
      },
    ]);
    stop();

    expect(publications).toEqual([[adjacentId]]);
    expect(useContextTabsStore.getState().byProject[projectId]).toMatchObject({
      selectedTabIdByWork: { "work-1": adjacentId },
    });
    expect(routes).toEqual([{ documentId: adjacentId, scheme: "manuscript", path: "Adjacent.md" }]);
    expect(search).toEqual({
      screen: "context",
      scheme: "manuscript",
      path: "Adjacent.md",
      work: "work-1",
    });
    expect(coordinator.getProjectSnapshot(projectId)).toMatchObject({
      selection: { status: "bound", identity: { documentId: adjacentId } },
      admitted: { scheme: "manuscript", path: "Adjacent.md", workId: "work-1" },
      removalFence: { removedDocumentIds: [documentId] },
    });
  });

  it("clears routed continuity when terminal availability removes the final tab", () => {
    useContextTabsStore.setState({
      byProject: {
        [projectId]: {
          tabs: [
            {
              kind: "tracked",
              documentId,
              scheme: "manuscript",
              path: "Only.md",
              name: "Only.md",
              editable: true,
              filetype: "markdown",
              schemaType: "document",
            },
          ],
          selectedTabIdByWork: { "work-1": documentId },
        },
      },
      _deskHydrated: true,
    });
    let search: ProjectSearch = {
      screen: "context",
      scheme: "manuscript",
      path: "Only.md",
      work: "work-1",
    };
    const route = {
      readSearch: () => search,
      updateSearch: (_projectId: string, update: (value: ProjectSearch) => ProjectSearch) => {
        search = update(search);
      },
    };
    const coordinator = new ContextRemovalCoordinator("account-1", { route });
    coordinator.registerRoutePort(projectId, route, "work-1");
    const revision = coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "Only.md",
      workId: "work-1",
    });
    coordinator.bindRouteSelection(projectId, revision, { kind: "server", documentId });

    coordinator.reconcileDocumentAvailability([
      {
        kind: "terminal-remove",
        commandId: `availability/v1/terminal-remove/${projectId}/${documentId}/28`,
        projectId,
        documentId,
        generation: "28",
        cause: "document-deleted",
      },
    ]);

    expect(useContextTabsStore.getState().byProject[projectId]).toEqual({
      tabs: [],
      selectedTabIdByWork: {},
    });
    expect(search).toEqual({ screen: "context", work: "work-1" });
    expect(coordinator.getProjectSnapshot(projectId)).toMatchObject({
      selection: { status: "none" },
      admitted: null,
      removalFence: { removedDocumentIds: [documentId] },
    });
  });

  it("publishes one final Zustand desk state for two commands", async () => {
    const secondId = "00000000-0000-4000-8000-000000000002";
    useContextTabsStore.setState({
      byProject: {
        [projectId]: {
          tabs: [
            {
              ...file(),
              kind: "tracked",
              documentId,
              scheme: "scratch",
              path: "Old.md",
              name: "Old.md",
              workId: "work-1",
            } as never,
            {
              ...file(),
              kind: "tracked",
              entryId: undefined,
              documentId: secondId,
              scheme: "scratch",
              path: "Other.md",
              name: "Other.md",
              workId: "work-1",
            } as never,
          ],
          selectedTabIdByWork: { "work-1": documentId },
        },
      },
      _deskHydrated: true,
    });
    const publications: string[][] = [];
    const stop = useContextTabsStore.subscribe((state) => {
      publications.push(state.byProject[projectId]?.tabs.map((tab) => tab.documentId) ?? []);
    });
    const coordinator = new ContextRemovalCoordinator("account-1");
    await coordinator.reconcileDocumentAvailability([
      {
        kind: "terminal-remove",
        commandId: `availability/v1/terminal-remove/${projectId}/${documentId}/8`,
        projectId,
        documentId,
        generation: "8",
        cause: "document-deleted",
      },
      {
        kind: "terminal-remove",
        commandId: `availability/v1/terminal-remove/${projectId}/${secondId}/8`,
        projectId,
        documentId: secondId,
        generation: "8",
        cause: "document-deleted",
      },
    ]);
    stop();
    expect(publications).toEqual([[]]);
  });

  it("starts B before deferred A settles and independently retains A rejection", async () => {
    const secondId = "00000000-0000-4000-8000-000000000002";
    let rejectA!: (reason: unknown) => void;
    const a = new Promise<never>((_resolve, reject) => {
      rejectA = reject;
    });
    const sessions = {
      revokeDocument: vi.fn(() => a),
      revokeAccess: vi.fn(async () => ({ revokedThrough: "8", persistence: "cleared" as const })),
    } as unknown as LiveDocumentSessionAuthority;
    const coordinator = new ContextRemovalCoordinator("account-1", { sessions });
    const receipt = coordinator.reconcileDocumentAvailability([
      {
        kind: "terminal-remove",
        commandId: `availability/v1/terminal-remove/${projectId}/${documentId}/8`,
        projectId,
        documentId,
        generation: "8",
        cause: "document-deleted",
      },
      {
        kind: "authority-revoke",
        commandId: `availability/v1/authority-revoke/${projectId}/${secondId}/8`,
        projectId,
        documentId: secondId,
        generation: "8",
        authority: { kind: "project", projectId },
        cause: "authority-unavailable",
      },
    ]);
    expect(sessions.revokeDocument).toHaveBeenCalledOnce();
    expect(sessions.revokeAccess).toHaveBeenCalledOnce();
    rejectA(new Error("offline"));
    const settled = await receipt.sessionSettlement;
    expect(Object.fromEntries(settled.map((item) => [item.operation, item.status]))).toEqual({
      "revoke-access": "fulfilled",
      "revoke-document": "rejected",
    });
  });
});

describe("availability Work authority and retry", () => {
  it("preserves Editor Work for project-scoped metadata while updating active and background tabs", () => {
    let search: ProjectSearch = {
      screen: "context",
      scheme: "kb",
      path: "Old.md",
      work: "work-editor",
    };
    useContextTabsStore.setState({
      byProject: {
        [projectId]: {
          tabs: [
            {
              kind: "tracked",
              documentId,
              scheme: "kb",
              path: "Old.md",
              name: "Old.md",
              editable: true,
              filetype: "markdown",
              schemaType: "document",
            },
            {
              kind: "tracked",
              documentId,
              scheme: "kb",
              path: "Copy.md",
              name: "Copy.md",
              editable: true,
              filetype: "markdown",
              schemaType: "document",
              draftOnly: true,
            },
          ],
          selectedTabIdByWork: { "work-editor": documentId },
        },
      },
      _deskHydrated: true,
    });
    const route = {
      readSearch: () => search,
      updateSearch: (_projectId: string, update: (latest: ProjectSearch) => ProjectSearch) => {
        search = update(search);
      },
    };
    const coordinator = new ContextRemovalCoordinator("account-1", { route });
    coordinator.registerRoutePort(projectId, route, "work-editor");
    const revision = coordinator.beginRouteSelection(projectId, {
      scheme: "kb",
      path: "Old.md",
      workId: "work-editor",
    });
    coordinator.bindRouteSelection(projectId, revision, { kind: "server", documentId });
    const entry = {
      ...file(),
      scope: { kind: "project" as const, projectId },
      uri: "kb://Lore/Renamed.md",
      path: ["Lore", "Renamed.md"],
      name: "Renamed.md",
    };
    coordinator.reconcileDocumentAvailability([
      {
        kind: "available",
        commandId: `availability/v1/available/${projectId}/${documentId}/10`,
        projectId,
        document: entry,
        generation: "10",
      },
    ]);
    expect(coordinator.getProjectSnapshot(projectId).activeWorkId).toBe("work-editor");
    expect(coordinator.getProjectSnapshot(projectId).selection).toMatchObject({
      locator: { workId: "work-editor", path: "Lore/Renamed.md" },
    });
    expect(search).toMatchObject({ work: "work-editor", path: "Lore/Renamed.md" });
    expect(useContextTabsStore.getState().byProject[projectId]?.tabs).toEqual([
      expect.objectContaining({ path: "Lore/Renamed.md" }),
    ]);
  });

  it("equal replay retries only the rejected session effect without local publication", async () => {
    let attempt = 0;
    const sessions = {
      revokeDocument: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("offline");
        return { revokedThrough: "8", persistence: "cleared" as const };
      }),
      revokeAccess: vi.fn(),
    } as unknown as LiveDocumentSessionAuthority;
    const coordinator = new ContextRemovalCoordinator("account-1", { sessions });
    const command = {
      kind: "terminal-remove" as const,
      commandId: `availability/v1/terminal-remove/${projectId}/${documentId}/8`,
      projectId,
      documentId,
      generation: "8",
      cause: "document-deleted" as const,
    };
    const publications: unknown[] = [];
    const stop = useContextTabsStore.subscribe((state) =>
      publications.push(state.byProject[projectId]),
    );
    const first = coordinator.reconcileDocumentAvailability([command]);
    await first.sessionSettlement;
    const afterLocal = publications.length;
    const replay = coordinator.reconcileDocumentAvailability([command]);
    expect(publications).toHaveLength(afterLocal);
    await replay.sessionSettlement;
    expect(sessions.revokeDocument).toHaveBeenCalledTimes(2);
    expect(replay.replayedCommandIds).toEqual([command.commandId]);
    stop();
  });

  it("joins an equal in-flight replay without orphaning its pending record", async () => {
    let resolve!: () => void;
    const deferred = new Promise<void>((settle) => {
      resolve = settle;
    });
    const sessions = {
      revokeDocument: vi.fn(() => deferred),
      revokeAccess: vi.fn(),
    } as unknown as LiveDocumentSessionAuthority;
    const coordinator = new ContextRemovalCoordinator("account-1", { sessions });
    const command = {
      kind: "terminal-remove" as const,
      commandId: `availability/v1/terminal-remove/${projectId}/${documentId}/18`,
      projectId,
      documentId,
      generation: "18",
      cause: "document-deleted" as const,
    };

    const first = coordinator.reconcileDocumentAvailability([command]);
    const replay = coordinator.reconcileDocumentAvailability([command]);
    expect(sessions.revokeDocument).toHaveBeenCalledOnce();
    resolve();
    await Promise.all([first.sessionSettlement, replay.sessionSettlement]);
    expect(await coordinator.retryPendingSessionEffects()).toEqual([]);
    expect(sessions.revokeDocument).toHaveBeenCalledOnce();

    await coordinator.reconcileDocumentAvailability([command]).sessionSettlement;
    expect(sessions.revokeDocument).toHaveBeenCalledTimes(2);
  });
});
