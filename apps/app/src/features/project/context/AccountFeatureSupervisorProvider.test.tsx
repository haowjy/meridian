// @vitest-environment jsdom
/** Root supervisor retention across descendant errors and cleanup retry. */
import { act, Component, useEffect, useState } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  AccountFeatureRootBoundary,
  AccountFeatureSupervisorProvider,
  useAccountFeatureSupervisor,
} from "./AccountFeatureSupervisorProvider";
import {
  AccountFeatureComposition,
  AccountFeatureSupervisorContext,
} from "./account-feature-context";
import {
  type AccountFeatureLifetime,
  AccountFeatureSupervisor,
} from "./account-feature-supervisor";

const auth = vi.hoisted(() => ({ value: { user: { id: "subject-a" }, loading: false } }));
vi.mock("@workos/authkit-tanstack-react-start/client", () => ({ useAuth: () => auth.value }));

class RouteBoundary extends Component<
  { resetKey: number; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidUpdate(previous: Readonly<{ resetKey: number }>) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false });
    }
  }
  render() {
    return this.state.failed ? <p>Route failed</p> : this.props.children;
  }
}

function controlledLifetime(accountId: string) {
  let state: "open" | "closing" | "closed" = "open";
  const attempts: Array<{ resolve(): void; reject(error: Error): void }> = [];
  return {
    attempts,
    value: {
      accountId,
      get state() {
        return state;
      },
      beginClose() {
        state = "closing";
      },
      finishClose() {
        return new Promise<void>((resolve, reject) => {
          attempts.push({
            resolve: () => {
              state = "closed";
              resolve();
            },
            reject,
          });
        });
      },
    } as unknown as AccountFeatureLifetime,
  };
}

it("keeps one A obligation through route error, reset, and root retry", async () => {
  auth.value = { user: { id: "subject-a" }, loading: false };
  const a = controlledLifetime("account-a");
  const created: string[] = [];
  const supervisor = new AccountFeatureSupervisor((accountId) => {
    created.push(accountId);
    return accountId === "account-a" ? a.value : controlledLifetime(accountId).value;
  });
  let changeAccount: ((subject: string, accountId: string) => void) | null = null;
  let failRoute: (() => void) | null = null;
  let resetRoute: (() => void) | null = null;

  function Declaration({ subject, accountId }: { subject: string; accountId: string }) {
    const owner = useAccountFeatureSupervisor();
    useEffect(() => owner.declareAccount(subject, accountId), [owner, subject, accountId]);
    return null;
  }
  function Thrower({ fail }: { fail: boolean }) {
    if (fail) throw new Error("descendant route failed");
    return <p>Route ready</p>;
  }
  function Harness() {
    const [account, setAccount] = useState({ subject: "subject-a", accountId: "account-a" });
    const [failed, setFailed] = useState(false);
    const [resetKey, setResetKey] = useState(0);
    changeAccount = (subject, accountId) => {
      auth.value = { user: { id: subject }, loading: false };
      setAccount({ subject, accountId });
    };
    failRoute = () => setFailed(true);
    resetRoute = () => {
      setFailed(false);
      setResetKey((value) => value + 1);
    };
    return (
      <AccountFeatureSupervisorProvider createSupervisor={() => supervisor}>
        <AccountFeatureRootBoundary>
          <Declaration subject={account.subject} accountId={account.accountId} />
          <RouteBoundary resetKey={resetKey}>
            <Thrower fail={failed} />
          </RouteBoundary>
        </AccountFeatureRootBoundary>
      </AccountFeatureSupervisorProvider>
    );
  }

  await withReactRoot(<Harness />, async () => {
    expect(created).toEqual(["account-a"]);
    await act(async () => changeAccount?.("subject-b", "account-b"));
    act(() => failRoute?.());
    expect(document.body.textContent).toContain("Route failed");
    a.attempts[0]?.reject(new Error("A close failed"));
    await act(async () => Promise.resolve());
    expect(document.body.textContent).toContain("Retry account cleanup");
    act(() => resetRoute?.());
    expect(document.body.textContent).toContain("Retry account cleanup");
    expect(created).toEqual(["account-a"]);

    const button = [...document.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Retry account cleanup"),
    );
    act(() => button?.click());
    a.attempts[1]?.resolve();
    await act(async () => Promise.resolve());
    expect(created).toEqual(["account-a", "account-b"]);
  });
});

it("hydrates the authenticated loading projection without constructing a lifetime", async () => {
  const createLifetime = vi.fn();
  const supervisor = new AccountFeatureSupervisor(createLifetime);
  const view = (
    <AccountFeatureSupervisorContext.Provider value={supervisor}>
      <AccountFeatureComposition
        authSubject="subject-a"
        accountId="account-a"
        repairProjectCatalog={async () => undefined}
      >
        <p>Authenticated content</p>
      </AccountFeatureComposition>
    </AccountFeatureSupervisorContext.Provider>
  );
  const html = renderToString(view);
  expect(html).toContain("Preparing your workspace");
  expect(createLifetime).not.toHaveBeenCalled();
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  const hydrationErrors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => hydrationErrors.push(args);
  const root = hydrateRoot(container, view);
  try {
    await act(async () => Promise.resolve());
    expect(container.textContent).toContain("Preparing your workspace");
    expect(createLifetime).not.toHaveBeenCalled();
    expect(
      hydrationErrors.filter((args) =>
        args.some(
          (value) =>
            typeof value === "string" && /hydration|server rendered|did not match/i.test(value),
        ),
      ),
    ).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    console.error = originalError;
    container.remove();
  }
});
