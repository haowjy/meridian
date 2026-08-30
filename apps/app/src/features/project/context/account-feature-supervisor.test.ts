/** Desired-account ordering and retained close-obligation contract. */
import { describe, expect, it, vi } from "vitest";
import {
  type AccountFeatureLifetime,
  AccountFeatureSupervisor,
} from "./account-feature-supervisor";

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
    supervisor.declareAccount("subject-a", "account-a");
    const a = lifetimes.get("account-a");
    if (!a) throw new Error("A was not constructed");

    supervisor.setAuthIntent({ loading: false, subject: "subject-b" });
    supervisor.declareAccount("subject-b", "account-b");
    supervisor.setAuthIntent({ loading: false, subject: "subject-c" });
    supervisor.declareAccount("subject-c", "account-c");
    expect(created).toEqual(["account-a"]);
    a.attempts[0]?.reject(new Error("first close failed"));
    await expect(a.attempts[0]?.promise).rejects.toThrow("first close failed");
    await Promise.resolve();
    expect(supervisor.getSnapshot()).toMatchObject({
      kind: "close-failed",
      closingAccountId: "account-a",
      desiredAccountId: "account-c",
    });
    supervisor.declareAccount("subject-c", "account-c");
    expect(a.attempts).toHaveLength(1);

    const retryA = supervisor.retry();
    const retryB = supervisor.retry();
    expect(retryA).toBe(retryB);
    a.attempts[1]?.resolve();
    await retryA;
    expect(created).toEqual(["account-a", "account-c"]);
    expect(supervisor.getSnapshot()).toMatchObject({ kind: "ready", accountId: "account-c" });
  });

  it("withholds a conflicting account for one subject until a later subject closes A", async () => {
    const a = lifetime("account-a");
    const create = vi.fn((accountId: string) =>
      accountId === "account-a" ? a.value : lifetime(accountId).value,
    );
    const supervisor = new AccountFeatureSupervisor(create);
    supervisor.setAuthIntent({ loading: false, subject: "same-subject" });
    supervisor.declareAccount("same-subject", "account-a");
    supervisor.declareAccount("same-subject", "account-conflict");
    expect(supervisor.getSnapshot()).toMatchObject({
      kind: "identity-inconsistent",
      retainedLifetime: true,
    });
    supervisor.declareAccount("same-subject", "account-a");
    expect(supervisor.getSnapshot().kind).toBe("identity-inconsistent");
    expect(create).toHaveBeenCalledTimes(1);

    supervisor.setAuthIntent({ loading: false, subject: "new-subject" });
    supervisor.declareAccount("new-subject", "account-b");
    a.attempts[0]?.reject(new Error("close retained A"));
    await expect(a.attempts[0]?.promise).rejects.toThrow();
    await Promise.resolve();
    expect(supervisor.getSnapshot().kind).toBe("close-failed");
    const retry = supervisor.retry();
    a.attempts[1]?.resolve();
    await retry;
    expect(supervisor.getSnapshot()).toMatchObject({ kind: "ready", accountId: "account-b" });
  });

  it("keeps retained A through signed out close failure and ignores stale declarations", async () => {
    const a = lifetime("account-a");
    const supervisor = new AccountFeatureSupervisor(() => a.value);
    supervisor.setAuthIntent({ loading: false, subject: "subject-a" });
    supervisor.declareAccount("subject-a", "account-a");
    supervisor.setAuthIntent({ loading: false, subject: null });
    supervisor.declareAccount("subject-a", "account-a");
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
});
