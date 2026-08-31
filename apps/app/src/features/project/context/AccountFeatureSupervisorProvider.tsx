/** AuthKit bridge and root-owned presentation for the account feature supervisor. */
import { Link } from "@tanstack/react-router";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { AccountFeatureSupervisorContext } from "./account-feature-context";
import { AccountFeatureSupervisor } from "./account-feature-supervisor";

export function AccountFeatureSupervisorProvider({
  children,
  createSupervisor = () => new AccountFeatureSupervisor(),
}: {
  children: React.ReactNode;
  createSupervisor?: () => AccountFeatureSupervisor;
}) {
  const { user, loading } = useAuth();
  const [supervisor] = useState(createSupervisor);
  useLayoutEffect(() => {
    supervisor.setAuthIntent({ loading, subject: user?.id ?? null });
  }, [supervisor, loading, user?.id]);
  useEffect(() => {
    const retry = () => {
      if (supervisor.getSnapshot().kind === "close-failed") void supervisor.retry();
    };
    window.addEventListener("online", retry);
    window.addEventListener("pageshow", retry);
    return () => {
      window.removeEventListener("online", retry);
      window.removeEventListener("pageshow", retry);
    };
  }, [supervisor]);
  return (
    <AccountFeatureSupervisorContext.Provider value={supervisor}>
      {children}
    </AccountFeatureSupervisorContext.Provider>
  );
}

export function AccountFeatureRootBoundary({ children }: { children: React.ReactNode }) {
  const supervisor = useAccountFeatureSupervisor();
  const snapshot = useSyncExternalStore(
    supervisor.subscribe,
    supervisor.getSnapshot,
    supervisor.getServerSnapshot,
  );
  if (snapshot.kind === "close-failed") {
    return (
      <AccountFailure title="We couldn't finish closing the previous workspace.">
        <Button type="button" onClick={() => void supervisor.retry()}>
          Retry account cleanup
        </Button>
      </AccountFailure>
    );
  }
  if (snapshot.kind === "identity-inconsistent") {
    return (
      <AccountFailure title="We couldn't verify this account.">
        <Button asChild>
          <Link to="/logout">Sign out</Link>
        </Button>
      </AccountFailure>
    );
  }
  if (snapshot.kind === "construction-failed") {
    return (
      <AccountFailure title="We couldn't prepare your workspace.">
        <Button type="button" onClick={() => void supervisor.retry()}>
          Retry workspace setup
        </Button>
      </AccountFailure>
    );
  }
  return children;
}

function AccountFailure({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="grid min-h-svh place-items-center bg-background px-6 text-foreground">
      <section className="grid max-w-md gap-4 text-center">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">
          Your next workspace will stay closed until this is resolved.
        </p>
        <div>{children}</div>
      </section>
    </main>
  );
}

export function useAccountFeatureSupervisor(): AccountFeatureSupervisor {
  const supervisor = useContext(AccountFeatureSupervisorContext);
  if (!supervisor) throw new Error("AccountFeatureSupervisorProvider is required");
  return supervisor;
}
