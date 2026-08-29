/** Project availability drain, ordering, and negative-space tests. */
import type {
  ProjectContextIdentityLookupResult,
  ProjectContextIdentityResolution,
} from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  ProjectContextAvailabilityCoordinator,
  type ProjectDocumentAvailabilityCommand,
} from "./project-context-availability-coordinator";

function id(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function result(
  projectId: string,
  resolutions: ProjectContextIdentityResolution[],
): ProjectContextIdentityLookupResult {
  return { projectId, resolutionId: crypto.randomUUID(), resolutions };
}

describe("ProjectContextAvailabilityCoordinator", () => {
  it("drains 257 sorted IDs through three requests, at most two concurrent, and one effect batch", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const calls: string[][] = [];
    const lookup = vi.fn(async (projectId: string, documentIds: readonly string[]) => {
      calls.push([...documentIds]);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 1));
      concurrent -= 1;
      return result(
        projectId,
        documentIds.map((documentId) => ({
          kind: "not-visible",
          documentId,
          checkedGeneration: "1",
        })),
      );
    });
    const batches: ProjectDocumentAvailabilityCommand[][] = [];
    const coordinator = new ProjectContextAvailabilityCoordinator({
      lookup,
      repairProjectCatalog: async () => undefined,
      apply: (commands) => {
        batches.push([...commands]);
      },
    });
    const ids = Array.from({ length: 257 }, (_, index) => id(257 - index));
    const lease = coordinator.attachProject("project-1");
    lease.watch(
      "tabs",
      ids.map((documentId) => ({ documentId })),
    );
    await coordinator.recheck("project-1", ids);
    expect(calls.map((call) => call.length)).toEqual([128, 128, 1]);
    expect(calls.flat()).toEqual([...ids].sort());
    expect(maxConcurrent).toBe(2);
    expect(batches).toHaveLength(1);
  });

  it("retries only a failed chunk and never dispatches malformed or unresolved data", async () => {
    const calls: string[][] = [];
    let failed = false;
    const batches: ProjectDocumentAvailabilityCommand[][] = [];
    const coordinator = new ProjectContextAvailabilityCoordinator({
      lookup: async (projectId, documentIds) => {
        calls.push([...documentIds]);
        if (!failed) {
          failed = true;
          throw new Error("503");
        }
        return result(
          projectId,
          documentIds.map((documentId) => ({
            kind: "deleted",
            documentId,
            generation: "8",
            lastAuthority: { kind: "project", projectId },
          })),
        );
      },
      repairProjectCatalog: async () => undefined,
      apply: (commands) => {
        batches.push([...commands]);
      },
      retryDelayMs: 0,
    });
    const lease = coordinator.attachProject("project-1");
    lease.watch("tabs", [{ documentId: id(1) }]);
    await coordinator.recheck("project-1", [id(1)]);
    expect(calls).toEqual([[id(1)], [id(1)]]);
    expect(batches[0]?.[0]?.commandId).toBe(`availability/v1/terminal-remove/project-1/${id(1)}/8`);
  });

  it("fences crossed authority generations and suppresses commands for indeterminate results", async () => {
    const batches: ProjectDocumentAvailabilityCommand[][] = [];
    const pending: Array<(value: ProjectContextIdentityLookupResult) => void> = [];
    const coordinator = new ProjectContextAvailabilityCoordinator({
      lookup: (_projectId, _documentIds) => new Promise((resolve) => pending.push(resolve)),
      repairProjectCatalog: async () => undefined,
      apply: (commands) => {
        batches.push([...commands]);
      },
    });
    const lease = coordinator.attachProject("project-1");
    lease.watch("tabs", [{ documentId: id(1) }]);
    const old = coordinator.recheck("project-1", [id(1)]);
    const newer = coordinator.recheck("project-1", [id(1)]);
    pending[1]?.(
      result("project-1", [
        {
          kind: "deleted",
          documentId: id(1),
          generation: "9",
          lastAuthority: { kind: "project", projectId: "project-1" },
        },
      ]),
    );
    await newer;
    pending[0]?.(
      result("project-1", [
        {
          kind: "available",
          documentId: id(1),
          generation: "8",
          authority: { kind: "project", projectId: "project-1" },
          entry: {} as never,
        },
      ]),
    );
    await old;
    expect(batches.flat().map((command) => command.generation)).toEqual(["9"]);

    const indeterminate = coordinator.recheck("project-1", [id(1)]);
    pending[2]?.(
      result("project-1", [
        {
          kind: "indeterminate",
          documentId: id(1),
          checkedGeneration: "10",
          reason: "identity_inconsistent",
        },
      ]),
    );
    for (let index = 0; index < 5 && pending.length < 4; index += 1) await Promise.resolve();
    pending[3]?.(
      result("project-1", [
        {
          kind: "indeterminate",
          documentId: id(1),
          checkedGeneration: "10",
          reason: "identity_inconsistent",
        },
      ]),
    );
    await indeterminate;
    expect(batches.flat()).toHaveLength(1);
  });

  it("does no work for an unwatched cold hint and exact-ID lookup for a watched cold hint", async () => {
    const lookup = vi.fn(async (projectId: string, documentIds: readonly string[]) =>
      result(
        projectId,
        documentIds.map((documentId) => ({
          kind: "not-visible",
          documentId,
          checkedGeneration: "1",
        })),
      ),
    );
    const coordinator = new ProjectContextAvailabilityCoordinator({
      lookup,
      repairProjectCatalog: async () => undefined,
      apply: () => undefined,
    });
    const lease = coordinator.attachProject("project-1");
    await coordinator.coldScopeHint("project-1", "work-cold");
    expect(lookup).not.toHaveBeenCalled();
    lease.watch("tabs", [{ documentId: id(1), sourceWorkId: "work-cold" }]);
    await coordinator.coldScopeHint("project-1", "work-cold");
    expect(lookup).toHaveBeenCalledWith("project-1", [id(1)]);
  });
});
