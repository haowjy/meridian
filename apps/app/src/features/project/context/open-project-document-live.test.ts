import type { CatalogFileEntry } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import { ProjectDocumentLiveOpener } from "./open-project-document";

const entry = {
  id: "document-a",
  name: "A.md",
  path: "/A.md",
  kind: "file",
  scheme: "manuscript",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
} as unknown as CatalogFileEntry;
const available = {
  kind: "available" as const,
  documentId: "document-a",
  generation: "4",
  authority: { kind: "project" as const, projectId: "project-a" },
  entry,
};

describe("ProjectDocumentLiveOpener", () => {
  it("uses exact availability as the only authority and binds the admitted lease", async () => {
    const lease = {
      accountId: "account-a",
      projectId: "project-a",
      documentId: "document-a",
      generation: "4",
    };
    const session = {} as never;
    const registry = {
      admit: vi.fn(async () => lease),
      retain: vi.fn(),
      get: vi.fn(() => session),
      release: vi.fn(),
    };
    const opener = new ProjectDocumentLiveOpener({
      availability: { resolveForOpen: vi.fn(async () => available) },
      registry: registry as never,
      adoption: { admitAndAdopt: vi.fn() },
      epochSignal: new AbortController().signal,
    });
    const result = await opener.open({
      source: "server",
      projectId: "project-a",
      documentId: "document-a",
    });
    expect(result.kind).toBe("opened");
    if (result.kind !== "opened") return;
    const binding = await result.admission.bind("tab-a");
    expect(binding.session).toBe(session);
    binding.release();
    binding.release();
    expect(registry.admit).toHaveBeenCalledOnce();
    expect(registry.release).toHaveBeenCalledOnce();
  });

  it.each([
    [{ kind: "deleted", documentId: "document-a", generation: "4" }, "deleted"],
    [{ kind: "not-visible", documentId: "document-a", checkedGeneration: "4" }, "not-visible"],
    [{ kind: "indeterminate", documentId: "document-a", checkedGeneration: "4" }, "indeterminate"],
    [{ kind: "failed" }, "failed"],
    [{ kind: "malformed" }, "failed"],
  ] as const)("fails closed for %s", async (resolution, reason) => {
    const registry = { admit: vi.fn() };
    const opener = new ProjectDocumentLiveOpener({
      availability: { resolveForOpen: vi.fn(async () => resolution as never) },
      registry: registry as never,
      adoption: { admitAndAdopt: vi.fn() },
      epochSignal: new AbortController().signal,
    });
    await expect(
      opener.open({ source: "server", projectId: "project-a", documentId: "document-a" }),
    ).resolves.toMatchObject({ kind: "unavailable", reason });
    expect(registry.admit).not.toHaveBeenCalled();
  });

  it("branches locally only after resolution and preserves the adopted session", async () => {
    const session = {} as never;
    const adoption = {
      admitAndAdopt: vi.fn(async () => ({
        lease: {
          accountId: "account-a",
          projectId: "project-a",
          documentId: "document-a",
          generation: "4",
        },
        session,
      })),
    };
    const opener = new ProjectDocumentLiveOpener({
      availability: { resolveForOpen: vi.fn(async () => available) },
      registry: {
        admit: vi.fn(),
        retain: vi.fn(),
        get: vi.fn(() => session),
        release: vi.fn(),
      } as never,
      adoption,
      epochSignal: new AbortController().signal,
    });
    const result = await opener.open({
      source: "local-untitled",
      projectId: "project-a",
      documentId: "document-a",
      handoff: {} as never,
    });
    expect(result.kind).toBe("opened");
    expect(adoption.admitAndAdopt).toHaveBeenCalledOnce();
  });

  it("cancels before and after exact resolution without admitting", async () => {
    const epoch = new AbortController();
    let resolve!: (value: typeof available) => void;
    const registry = { admit: vi.fn() };
    const opener = new ProjectDocumentLiveOpener({
      availability: {
        resolveForOpen: vi.fn(
          () =>
            new Promise<typeof available>((done) => {
              resolve = done;
            }),
        ),
      },
      registry: registry as never,
      adoption: { admitAndAdopt: vi.fn() },
      epochSignal: epoch.signal,
    });
    const pending = opener.open({
      source: "server",
      projectId: "project-a",
      documentId: "document-a",
    });
    epoch.abort();
    resolve(available);
    await expect(pending).resolves.toEqual({ kind: "cancelled" });
    expect(registry.admit).not.toHaveBeenCalled();
  });
});
