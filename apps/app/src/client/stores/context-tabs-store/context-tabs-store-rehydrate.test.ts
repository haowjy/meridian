// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  type AccountFeatureLifetime,
  AccountFeatureSupervisor,
} from "@/features/project/context/account-feature-supervisor";
import {
  CONTEXT_DESK_STORAGE_KEY,
  DeviceContextDeskLedger,
  parseContextDesk,
} from "./context-desk-storage";
import { getContextTabs, rehydrateContextDesks, useContextTabsStore } from "./context-tabs-store";

afterEach(() => localStorage.clear());

it("resets a fresh durable account envelope before projecting the next account", async () => {
  localStorage.setItem(
    CONTEXT_DESK_STORAGE_KEY,
    JSON.stringify({
      version: 3,
      accountId: "fresh-account-A",
      deskRevision: 7,
      projects: {},
    }),
  );
  useContextTabsStore.setState({ byProject: {}, _deskHydrated: false, _deskRevision: 0 });

  await rehydrateContextDesks("fresh-account-B");

  await vi.waitFor(() => {
    expect(JSON.parse(localStorage.getItem(CONTEXT_DESK_STORAGE_KEY) ?? "null")).toMatchObject({
      accountId: "fresh-account-B",
      deskRevision: 8,
      projects: {},
    });
    expect(useContextTabsStore.getState()).toMatchObject({
      byProject: {},
      _deskHydrated: true,
      _deskRevision: 8,
    });
  });
});

it("withholds the next account behind the exact old-account reset fence", async () => {
  class SerialGateLocks {
    private tail = Promise.resolve();
    private releaseGate: (() => void) | null = null;
    entered: Promise<void> = Promise.resolve();
    private enter: (() => void) | null = null;
    private armed = false;

    arm() {
      this.armed = true;
      this.entered = new Promise<void>((resolve) => {
        this.enter = resolve;
      });
    }
    release() {
      this.releaseGate?.();
      this.releaseGate = null;
    }
    request<T>(
      _name: string,
      _options: { mode: "exclusive" },
      callback: () => T | Promise<T>,
    ): Promise<T> {
      const run = this.tail.then(async () => {
        if (this.armed) {
          this.armed = false;
          this.enter?.();
          this.enter = null;
          await new Promise<void>((resolve) => {
            this.releaseGate = resolve;
          });
        }
        return callback();
      });
      this.tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }
  }

  const locks = new SerialGateLocks();
  Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
  const accountA = `fence-a-${crypto.randomUUID()}`;
  const accountB = `fence-b-${crypto.randomUUID()}`;
  await rehydrateContextDesks(accountA);
  await useContextTabsStore.getState().openTab("fence-project", {
    kind: "tracked",
    tabInstanceId: "review-tab",
    documentId: "review-document",
    scheme: "manuscript",
    path: "/review.md",
    name: "review.md",
    editable: true,
    filetype: "markdown",
    schemaType: "document",
    draftOnly: true,
    reviewWorkId: "work",
    reviewDraftId: "draft",
    tabInstanceToken: "token",
  });
  localStorage.removeItem(CONTEXT_DESK_STORAGE_KEY);

  locks.arm();
  const reviewTab = getContextTabs("fence-project").tabs[0];
  if (!reviewTab) throw new Error("review tab was not mounted");
  const oldSettlement = useContextTabsStore
    .getState()
    .settleDraft("fence-project", reviewTab, "applied");
  await locks.entered;

  const created: string[] = [];
  const supervisor = new AccountFeatureSupervisor((accountId) => {
    created.push(accountId);
    return { accountId } as AccountFeatureLifetime;
  }, rehydrateContextDesks);
  supervisor.setAuthSubject("subject-b");
  const auth = supervisor.getAuthDeclaration();
  if (!auth) throw new Error("missing auth declaration");
  supervisor.declareAccount({ auth, account: { id: accountB } });

  expect(supervisor.getSnapshot()).toMatchObject({
    kind: "awaiting-composition",
    desiredAccountId: accountB,
  });
  expect(created).toEqual([]);
  expect(useContextTabsStore.getState()._deskHydrated).toBe(false);

  locks.release();
  await expect(oldSettlement).resolves.toEqual({ kind: "settled" });
  await vi.waitFor(() => expect(supervisor.getSnapshot().kind).toBe("ready"));
  expect(created).toEqual([accountB]);
  expect(parseContextDesk(localStorage.getItem(CONTEXT_DESK_STORAGE_KEY))).toMatchObject({
    accountId: accountB,
    projects: {},
  });
  expect(useContextTabsStore.getState()).toMatchObject({
    byProject: {},
    _deskHydrated: true,
  });
});

it("resets a non-null old desk and makes a late old-account command stale", async () => {
  const accountA = `nonnull-a-${crypto.randomUUID()}`;
  const accountB = `nonnull-b-${crypto.randomUUID()}`;
  await rehydrateContextDesks(accountA);
  await useContextTabsStore.getState().openTab("old-project", {
    kind: "tracked",
    tabInstanceId: "old-tab",
    documentId: "old-document",
    scheme: "manuscript",
    path: "/old.md",
    name: "old.md",
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  });
  const lateA = new DeviceContextDeskLedger(localStorage, accountA);

  await rehydrateContextDesks(accountB);
  expect(parseContextDesk(localStorage.getItem(CONTEXT_DESK_STORAGE_KEY))).toMatchObject({
    accountId: accountB,
    projects: {},
  });
  await expect(
    lateA.apply({
      kind: "open",
      projectId: "late-project",
      tab: {
        kind: "tracked",
        tabInstanceId: "late-tab",
        documentId: "late-document",
        scheme: "manuscript",
        path: "/late.md",
        name: "late.md",
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      },
    }),
  ).resolves.toMatchObject({ kind: "stale", snapshot: { accountId: accountB } });
  expect(parseContextDesk(localStorage.getItem(CONTEXT_DESK_STORAGE_KEY))).toMatchObject({
    accountId: accountB,
    projects: {},
  });
  expect(useContextTabsStore.getState().byProject).toEqual({});
});

it("keeps a failed durable reset retryable and withholds the desired account", async () => {
  const accountA = `failure-a-${crypto.randomUUID()}`;
  const accountB = `failure-b-${crypto.randomUUID()}`;
  await rehydrateContextDesks(accountA);
  localStorage.removeItem(CONTEXT_DESK_STORAGE_KEY);
  const originalSetItem = Storage.prototype.setItem;
  let failReset = true;
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    if (failReset && key === CONTEXT_DESK_STORAGE_KEY) throw new Error("injected reset failure");
    return originalSetItem.call(this, key, value);
  });
  try {
    const created: string[] = [];
    const supervisor = new AccountFeatureSupervisor((accountId) => {
      created.push(accountId);
      return { accountId } as AccountFeatureLifetime;
    }, rehydrateContextDesks);
    supervisor.setAuthSubject("subject-b");
    const auth = supervisor.getAuthDeclaration();
    if (!auth) throw new Error("missing auth declaration");
    supervisor.declareAccount({ auth, account: { id: accountB } });
    await vi.waitFor(() => expect(supervisor.getSnapshot().kind).toBe("construction-failed"));
    expect(created).toEqual([]);
    expect(localStorage.getItem(CONTEXT_DESK_STORAGE_KEY)).toBeNull();

    failReset = false;
    await supervisor.retry();
    expect(created).toEqual([accountB]);
    expect(supervisor.getSnapshot().kind).toBe("ready");
    expect(parseContextDesk(localStorage.getItem(CONTEXT_DESK_STORAGE_KEY))).toMatchObject({
      accountId: accountB,
      projects: {},
    });
  } finally {
    setItem.mockRestore();
  }
});
