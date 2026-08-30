import type { AccountId, LiveDocumentSessionLease } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import { createAccountDocumentSessionRuntime } from "./account-document-session-runtime";
import type { LiveDocumentSessionRegistry } from "./document-session-registry";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("AccountDocumentSessionRuntime", () => {
  it("fences synchronously, permits teardown, awaits ordered close, and withholds B", async () => {
    const localClosed = deferred();
    const registryClosed = deferred();
    const pendingAdmission = deferred();
    const pendingAdoption = deferred();
    const release = vi.fn();
    const registry = {
      admit: vi.fn(async () => {
        await pendingAdmission.promise;
        return {} as LiveDocumentSessionLease;
      }),
      release,
    };
    const reservation = { reserve: vi.fn() };
    const adoption = {
      admitAndAdopt: vi.fn(async () => {
        await pendingAdoption.promise;
        return {} as never;
      }),
    };
    const order: string[] = [];
    const runtime = createAccountDocumentSessionRuntime({
      accountId: "account-a" as AccountId,
      registry: registry as unknown as LiveDocumentSessionRegistry,
      localReservation: reservation,
      localAdoption: adoption,
      closeLocalSessions: async () => {
        order.push("local-start");
        await localClosed.promise;
        order.push("local-finished");
      },
      closeRegistry: async () => {
        order.push("registry-start");
        await registryClosed.promise;
        order.push("registry-finished");
      },
    });

    const opening = runtime.registry.admit("project", "document", "1");
    const adopting = runtime.localAdoption.admitAndAdopt({} as never);
    runtime.beginClose();
    expect(runtime.epochSignal.aborted).toBe(true);
    expect(() => runtime.registry.admit("project", "document", "1")).toThrow(/closing/);
    expect(() => runtime.localReservation.reserve({} as never)).toThrow(/closing/);
    await expect(runtime.localAdoption.admitAndAdopt({} as never)).rejects.toThrow(/closing/);
    runtime.registry.release("owner");
    expect(release).toHaveBeenCalledWith("owner");
    pendingAdmission.resolve();
    pendingAdoption.resolve();
    await expect(opening).rejects.toThrow(/closing/);
    await expect(adopting).rejects.toThrow(/closing/);

    let accountBExposed = false;
    const switchAccount = runtime.finishClose().then(() => {
      accountBExposed = true;
    });
    await Promise.resolve();
    expect(order).toEqual(["local-start"]);
    expect(accountBExposed).toBe(false);
    localClosed.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["local-start", "local-finished", "registry-start"]);
    expect(accountBExposed).toBe(false);
    registryClosed.resolve();
    await switchAccount;
    expect(accountBExposed).toBe(true);
    expect(order).toEqual(["local-start", "local-finished", "registry-start", "registry-finished"]);
    await runtime.finishClose();
  });
});
