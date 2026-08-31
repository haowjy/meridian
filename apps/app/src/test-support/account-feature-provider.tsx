/** Test composition for feature suites that need one complete account lifetime. */
import { useLayoutEffect, useState } from "react";
import {
  AccountFeatureComposition,
  AccountFeatureSupervisorContext,
} from "@/features/project/context/account-feature-context";
import { AccountFeatureSupervisor } from "@/features/project/context/account-feature-supervisor";

export * from "@/features/project/context/account-feature-context";

export function AccountFeatureTestProvider({
  accountId,
  repairProjectCatalog = async () => undefined,
  children,
}: {
  accountId: string;
  repairProjectCatalog?: (projectId: string) => Promise<void>;
  children: React.ReactNode;
}) {
  const [supervisor] = useState(() => new AccountFeatureSupervisor(undefined, () => undefined));
  useLayoutEffect(() => {
    supervisor.setAuthSubject(accountId);
  }, [supervisor, accountId]);
  return (
    <AccountFeatureSupervisorContext.Provider value={supervisor}>
      <AccountFeatureComposition
        authSubject={accountId}
        accountId={accountId}
        repairProjectCatalog={repairProjectCatalog}
      >
        {children}
      </AccountFeatureComposition>
    </AccountFeatureSupervisorContext.Provider>
  );
}
