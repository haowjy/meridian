/** Desired-account ordering and retained close-obligation contract. */
import { describe, expect, it, vi } from "vitest";
import {
  type AccountFeatureDeclaration,
  type AccountFeatureLifetime,
  AccountFeatureSupervisor,
} from "./account-feature-supervisor";

function declaration(
  supervisor: AccountFeatureSupervisor,
  accountId: string,
): AccountFeatureDeclaration {
  const auth = supervisor.getAuthDeclaration();
  if (!auth) throw new Error("Authenticated epoch is missing");
  return { auth, account: { id: accountId } };
}

function lifetime(accountId: string) {
  let state: "open" | "closing" | "closed" = "open";
  const attempts: Array<{
    resolve(): void;
    reject(error: Error): void;
    promise: Promise<void>;
  }> = [];
  const value = {
    accountId,
    get state() {
      return state;
    },
    beginClose: vi.fn(() => {
      state = "closing";
    }),
    finishClose: vi.fn(() => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((done, fail) => {
        resolve = () => {
          state = "closed";
          done();
        };
        reject = fail;
      });
      attempts.push({ resolve, reject, promise });
      return promise;
    }),
  };
  return { value: value as unknown as AccountFeatureLifetime, attempts };
}

describe("AccountFeatureSupervisor", () => {
  it("retains A across failure and B to C replacement until retry closes A", async () => {
    const created: string[] = [];
    const lifetimes = new Map<string, ReturnType<typeof lifetime>>();
    const supervisor = new AccountFeatureSupervisor((accountId) => {
      created.push(accountId);
      const item = lifetime(accountId);
      lifetimes.set(accountId, item);
      return item.value;
    });
    supervisor.setAuthIntent({ loading: false, subject: "subject-a" });
    supervisor.declareAccount(declaration(supervisor, "account-a"));
    const a = lifetimes.get("account-a");
    if (!a) throw new Error("A was not constructed");

    supervisor.setAuthIntent({ loading: false, subject: "subject-b" });
    supervisor.declareAccount(declaration(supervisor, "account-b"));
    supervisor.setAuthIntent({ loading: false, subject: "subject-c" });
    supervisor.declareAccount(declaration(supervisor, "account-c"));
    expect(created).toEqual(["account-a"]);
    a.attempts[0]?.reject(new Error("first close failed"));
    await expect(a.attempts[0]?.promise).rejects.toThrow("first close failed");
    await Promise.resolve();
    expect(supervisor.getSnapshot()).toMatchObject({
      kind: "close-failed",
      closingAccountId: "account-a",
      desiredAccountId: "account-c",
    });
    supervisor.declareAccount(declaration(supervisor, "account-c"));
    expect(a.attempts).toHaveLength(1);

    const retryA = supervisor.retry();
    const retryB = supervisor.retry();
    expect(retryA).toBe(retryB);
    a.attempts[1]?.resolve();
    await retryA;
    expect(created).toEqual(["account-a", "account-c"]);
    expect(supervisor.getSnapshot()).toMatchObject({
      kind: "ready",
      declaration: { account: { id: "account-c" } },
    });
  });

  it("withholds a conflicting account for one subject until a later subject closes A", async () => {
    const a = lifetime("account-a");
    const create = vi.fn((accountId: string) =>
      accountId === "account-a" ? a.value : lifetime(accountId).value,
    );
    const supervisor = new AccountFeatureSupervisor(create);
    supervisor.setAuthIntent({ loading: false, subject: "same-subject" });
    supervisor.declareAccount(declaration(supervisor, "account-a"));
    supervisor.declareAccount(declaration(supervisor, "account-conflict"));
    expect(supervisor.getSnapshot()).toMatchObject({
      kind: "identity-inconsistent",
      retainedLifetime: true,
    });
    supervisor.declareAccount(declaration(supervisor, "account-a"));
    expect(supervisor.getSnapshot().kind).toBe("identity-inconsistent");
    expect(create).toHaveBeenCalledTimes(1);

    supervisor.setAuthIntent({ loading: false, subject: "new-subject" });
    supervisor.declareAccount(declaration(supervisor, "account-b"));
    a.attempts[0]?.reject(new Error("close retained A"));
    await expect(a.attempts[0]?.promise).rejects.toThrow();
    await Promise.resolve();
    expect(supervisor.getSnapshot().kind).toBe("close-failed");
    const retry = supervisor.retry();
    a.attempts[1]?.resolve();
    await retry;
    expect(supervisor.getSnapshot()).toMatchObject({
      kind: "ready",
      declaration: { account: { id: "account-b" } },
    });
  });

  it("keeps retained A through signed out close failure and ignores stale declarations", async () => {
    const a = lifetime("account-a");
    const supervisor = new AccountFeatureSupervisor(() => a.value);
    supervisor.setAuthIntent({ loading: false, subject: "subject-a" });
    const stale = declaration(supervisor, "account-a");
    supervisor.declareAccount(stale);
    supervisor.setAuthIntent({ loading: false, subject: null });
    supervisor.declareAccount(stale);
    a.attempts[0]?.reject(new Error("sign-out close failed"));
    await expect(a.attempts[0]?.promise).rejects.toThrow();
    await Promise.resolve();
    expect(supervisor.getSnapshot()).toMatchObject({
      kind: "close-failed",
      desiredAccountId: null,
    });
    const retry = supervisor.retry();
    a.attempts[1]?.resolve();
    await retry;
    expect(supervisor.getSnapshot().kind).toBe("idle");
  });

  it("ignores a declaration from an earlier epoch of the same auth subject", async () => {
    const created: string[] = [];
    const lifetimes = new Map<string, ReturnType<typeof lifetime>>();
    const supervisor = new AccountFeatureSupervisor((accountId) => {
      created.push(accountId);
      const item = lifetime(accountId);
      lifetimes.set(accountId, item);
      return item.value;
    });
    supervisor.setAuthIntent({ loading: false, subject: "same-subject" });
    const stale = declaration(supervisor, "account-a");
    supervisor.declareAccount(stale);
    supervisor.setAuthIntent({ loading: false, subject: null });
    const first = lifetimes.get("account-a");
    if (!first) throw new Error("First lifetime was not created");
    first.attempts[0]?.resolve();
    await first.attempts[0]?.promise;

    supervisor.setAuthIntent({ loading: false, subject: "same-subject" });
    const current = declaration(supervisor, "account-b");
    supervisor.declareAccount(stale);
    expect(created).toEqual(["account-a"]);
    expect(supervisor.getSnapshot()).toMatchObject({ kind: "idle" });

    supervisor.declareAccount(current);
    expect(created).toEqual(["account-a", "account-b"]);
    expect(supervisor.getSnapshot()).toMatchObject({
      kind: "ready",
      declaration: { auth: { epoch: current.auth.epoch }, account: { id: "account-b" } },
    });
  });
});
