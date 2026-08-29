/** Existing-owner integration for project-final availability command batches. */
import type { CatalogFileEntry, LiveDocumentSessionAuthority } from "@meridian/contracts/protocol";
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
      {
        kind: "terminal-remove",
        commandId: `availability/v1/terminal-remove/${projectId}/${documentId}/9`,
        projectId,
        documentId,
        generation: "9",
        cause: "document-deleted",
      },
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
});
