import type { CatalogFileEntry } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  ProjectDocumentLiveOpener,
  ProjectDocumentNavigationAdapter,
} from "./open-project-document";

const entry = {
  entryId: "document-a",
  scope: { kind: "project", projectId: "project-a" },
  sourceId: "source-a",
  parentId: "source-a",
  aliases: [],
  name: "A.md",
  path: ["A.md"],
  uri: "manuscript://project-a/A.md",
  provisionalName: false,
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
    const session = {
      getSnapshot: () => ({ status: "synced", connectionState: null }),
    } as never;
    const registry = {
      admit: vi.fn(async () => lease),
      retain: vi.fn(),
      get: vi.fn(() => session),
      release: vi.fn(),
      restartUnavailableRoom: vi.fn(),
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
    const session = {
      getSnapshot: () => ({ status: "synced", connectionState: null }),
    } as never;
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
        restartUnavailableRoom: vi.fn(),
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
    const resolveForOpen = vi.fn(
      () =>
        new Promise<typeof available>((done) => {
          resolve = done;
        }),
    );
    const opener = new ProjectDocumentLiveOpener({
      availability: { resolveForOpen },
      registry: registry as never,
      adoption: { admitAndAdopt: vi.fn() },
      epochSignal: epoch.signal,
    });

    const preStart = new AbortController();
    preStart.abort();
    await expect(
      opener.open({
        source: "server",
        projectId: "project-a",
        documentId: "document-a",
        signal: preStart.signal,
      }),
    ).resolves.toEqual({ kind: "cancelled" });
    expect(resolveForOpen).not.toHaveBeenCalled();

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

  it.each([
    "server",
    "local-untitled",
  ] as const)("normalizes a rejected %s admission without leaking capability effects", async (source) => {
    let rejectAdmission!: (error: Error) => void;
    let admissionStartedResolve!: () => void;
    const admissionStarted = new Promise<void>((resolve) => {
      admissionStartedResolve = resolve;
    });
    const failed = new Error("authority changed during admission");
    const admission = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectAdmission = reject;
          admissionStartedResolve();
        }),
    );
    const registry = {
      admit: source === "server" ? admission : vi.fn(),
      retain: vi.fn(),
      get: vi.fn(),
      release: vi.fn(),
      restartUnavailableRoom: vi.fn(),
    };
    const adoption = { admitAndAdopt: source === "local-untitled" ? admission : vi.fn() };
    const opener = new ProjectDocumentLiveOpener({
      availability: { resolveForOpen: vi.fn(async () => available) },
      registry: registry as never,
      adoption: adoption as never,
      epochSignal: new AbortController().signal,
    });

    const opened = opener.open(
      source === "server"
        ? { source, projectId: "project-a", documentId: "document-a" }
        : {
            source,
            projectId: "project-a",
            documentId: "document-a",
            handoff: {} as never,
          },
    );
    await admissionStarted;
    rejectAdmission(failed);

    await expect(opened).resolves.toEqual({ kind: "unavailable", reason: "failed" });
    expect(registry.retain).not.toHaveBeenCalled();
    expect(registry.get).not.toHaveBeenCalled();
    expect(registry.release).not.toHaveBeenCalled();
    expect(registry.restartUnavailableRoom).not.toHaveBeenCalled();
  });

  it.each([
    "request",
    "epoch",
  ] as const)("gives %s cancellation precedence over rejected admission", async (abortKind) => {
    const request = new AbortController();
    const epoch = new AbortController();
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let rejectAdmission!: (error: Error) => void;
    const opener = new ProjectDocumentLiveOpener({
      availability: { resolveForOpen: vi.fn(async () => available) },
      registry: {
        admit: () =>
          new Promise<never>((_resolve, reject) => {
            rejectAdmission = reject;
            startedResolve();
          }),
      } as never,
      adoption: { admitAndAdopt: vi.fn() },
      epochSignal: epoch.signal,
    });
    const opened = opener.open({
      source: "server",
      projectId: "project-a",
      documentId: "document-a",
      signal: request.signal,
    });
    await started;
    (abortKind === "request" ? request : epoch).abort();
    rejectAdmission(new Error("fenced"));
    await expect(opened).resolves.toEqual({ kind: "cancelled" });
  });

  it("gives cancellation precedence when exact lookup rejects after abort", async () => {
    const request = new AbortController();
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let rejectLookup!: (error: Error) => void;
    const opener = new ProjectDocumentLiveOpener({
      availability: {
        resolveForOpen: () =>
          new Promise<never>((_resolve, reject) => {
            rejectLookup = reject;
            startedResolve();
          }),
      },
      registry: { admit: vi.fn() } as never,
      adoption: { admitAndAdopt: vi.fn() },
      epochSignal: new AbortController().signal,
    });
    const opened = opener.open({
      source: "server",
      projectId: "project-a",
      documentId: "document-a",
      signal: request.signal,
    });
    await started;
    request.abort();
    rejectLookup(new Error("lookup failed"));
    await expect(opened).resolves.toEqual({ kind: "cancelled" });
  });

  it("coalesces repeated bindings through registry authority", async () => {
    const lease = {
      accountId: "account-a",
      projectId: "project-a",
      documentId: "document-a",
      generation: "4",
    };
    const session = {
      getSnapshot: () => ({ status: "synced", connectionState: null }),
    } as never;
    const registry = {
      admit: vi.fn(async () => lease),
      retain: vi.fn(),
      get: vi.fn(() => session),
      release: vi.fn(),
      restartUnavailableRoom: vi.fn(),
    };
    const opener = new ProjectDocumentLiveOpener({
      availability: { resolveForOpen: vi.fn(async () => available) },
      registry: registry as never,
      adoption: { admitAndAdopt: vi.fn() },
      epochSignal: new AbortController().signal,
    });

    const [first, second] = await Promise.all([
      opener.open({ source: "server", projectId: "project-a", documentId: "document-a" }),
      opener.open({ source: "server", projectId: "project-a", documentId: "document-a" }),
    ]);
    if (first.kind !== "opened" || second.kind !== "opened") throw new Error("open failed");
    const [a, b] = await Promise.all([
      first.admission.bind("tab-a"),
      second.admission.bind("tab-b"),
    ]);
    expect(a.session).toBe(session);
    expect(b.session).toBe(session);
    expect(registry.retain).toHaveBeenCalledTimes(2);
    a.release();
    b.release();
  });

  it.each([
    { status: "access-lost", connectionState: null },
    { status: "offline", connectionState: { kind: "unauthorized" } },
    { status: "offline", connectionState: { kind: "terminal" } },
  ])("repairs a retained unavailable session through its exact lease before bind", async (snapshot) => {
    const lease = {
      accountId: "account-a",
      projectId: "project-a",
      documentId: "document-a",
      generation: "4",
    };
    const session = { getSnapshot: () => ({ ...snapshot, schemaFence: null }) } as never;
    const registry = {
      admit: vi.fn(async () => lease),
      retain: vi.fn(),
      get: vi.fn(() => session),
      release: vi.fn(),
      restartUnavailableRoom: vi.fn(async () => true),
    };
    const opener = new ProjectDocumentLiveOpener({
      availability: { resolveForOpen: vi.fn(async () => available) },
      registry: registry as never,
      adoption: { admitAndAdopt: vi.fn() },
      epochSignal: new AbortController().signal,
    });

    const opened = await opener.open({
      source: "server",
      projectId: "project-a",
      documentId: "document-a",
    });
    if (opened.kind !== "opened") throw new Error("open failed");
    await opened.admission.bind("tab-a");

    expect(registry.restartUnavailableRoom).toHaveBeenCalledWith(lease);
  });
});

describe("ProjectDocumentNavigationAdapter", () => {
  const admission = { bind: vi.fn() } as never;
  const opened = { kind: "opened" as const, document: entry, admission };

  it("keeps current and background disposition explicit", async () => {
    const openTab = vi.fn();
    const openRoute = vi.fn(async (): Promise<void> => undefined);
    const adapter = new ProjectDocumentNavigationAdapter({
      opener: { open: vi.fn(async () => opened) },
      openTab,
      openRoute,
    });
    await expect(
      adapter.open("project-a", { documentId: "document-a", disposition: "background" }),
    ).resolves.toBe(opened);
    expect(openTab).toHaveBeenCalledOnce();
    expect(openRoute).not.toHaveBeenCalled();

    await expect(
      adapter.open("project-a", { documentId: "document-a", disposition: "current" }),
    ).resolves.toBe(opened);
    expect(openRoute).toHaveBeenCalledWith({
      scheme: "manuscript",
      path: "/A.md",
      workId: null,
    });
  });

  it("fences stale route tokens before and after opener acceptance", async () => {
    let resolveFirst!: (value: typeof opened) => void;
    const open = vi.fn(async () => opened);
    open.mockImplementationOnce(
      () => new Promise<typeof opened>((resolve) => (resolveFirst = resolve)),
    );
    const openTab = vi.fn();
    const openRoute = vi.fn(async (): Promise<void> => undefined);
    const adapter = new ProjectDocumentNavigationAdapter({ opener: { open }, openTab, openRoute });
    const stale = adapter.open("project-a", { documentId: "document-a" });
    const current = adapter.open("project-a", { documentId: "document-a" });
    resolveFirst(opened);
    await expect(stale).resolves.toEqual({ kind: "cancelled" });
    await expect(current).resolves.toBe(opened);
    expect(openTab).toHaveBeenCalledOnce();

    let finishRoute!: () => void;
    openRoute.mockImplementationOnce(() => new Promise<void>((resolve) => (finishRoute = resolve)));
    const postStart = adapter.open("project-a", { documentId: "document-a" });
    await vi.waitFor(() => expect(openRoute).toHaveBeenCalledTimes(2));
    const replacement = adapter.open("project-a", {
      documentId: "document-a",
      disposition: "background",
    });
    finishRoute();
    await expect(postStart).resolves.toEqual({ kind: "cancelled" });
    await expect(replacement).resolves.toBe(opened);
  });
});
