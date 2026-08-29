/** Ambient Drizzle transaction context shared by adapters that must participate in one app-level DB transaction. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "@meridian/database";

export type DrizzleDatabase = Database;
export type DrizzleTransaction = Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0];
export type DrizzleDb = DrizzleDatabase | DrizzleTransaction;

type DrizzleTransactionContext = {
  db: DrizzleDb;
  afterCommit: Array<() => void | Promise<void>>;
  afterRollback: Array<() => void | Promise<void>>;
  locals: Map<object, unknown>;
};

const transactionStorage = new AsyncLocalStorage<DrizzleTransactionContext>();

export function currentDrizzleDb(db: DrizzleDb): DrizzleDb {
  return transactionStorage.getStore()?.db ?? db;
}

export async function runInDrizzleTransaction<T>(
  db: DrizzleDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  const active = transactionStorage.getStore();
  if (active) return operation();
  const context: DrizzleTransactionContext = {
    db,
    afterCommit: [],
    afterRollback: [],
    locals: new Map(),
  };
  let result: T;
  try {
    result = await db.transaction((tx) => {
      context.db = tx;
      return transactionStorage.run(context, operation);
    });
  } catch (cause) {
    await dispatchAfterRollback(context.afterRollback, cause);
    throw cause;
  }
  await dispatchAfterCommit(context.afterCommit);
  return result;
}

export async function runInRootDrizzleTransaction<T>(
  db: DrizzleDatabase,
  operation: () => Promise<T>,
  options?: { isolationLevel?: "repeatable read"; accessMode?: "read only" },
): Promise<T> {
  return transactionStorage.exit(async () => {
    const context: DrizzleTransactionContext = {
      db,
      afterCommit: [],
      afterRollback: [],
      locals: new Map(),
    };
    let result: T;
    try {
      result = await db.transaction((tx) => {
        context.db = tx;
        return transactionStorage.run(context, operation);
      }, options);
    } catch (cause) {
      await dispatchAfterRollback(context.afterRollback, cause);
      throw cause;
    }
    await dispatchAfterCommit(context.afterCommit);
    return result;
  });
}

/** One root, read-only repeatable-read snapshot while preserving ambient adapter joins. */
export async function runInRootDrizzleReadSnapshot<T>(
  db: DrizzleDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  return runInRootDrizzleTransaction(db, operation, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

/**
 * Run an adapter-atomic unit. Inside an ambient command transaction this is a
 * real nested Drizzle transaction/savepoint; its commit callbacks remain
 * subordinate to the outer commit.
 */
export async function runInDrizzleSavepoint<T>(
  db: DrizzleDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  const parent = transactionStorage.getStore();
  if (!parent) return runInDrizzleTransaction(db, operation);
  const transactional = parent.db as DrizzleTransaction;
  const child: DrizzleTransactionContext = {
    db: transactional,
    afterCommit: [],
    afterRollback: [],
    locals: new Map(parent.locals),
  };
  try {
    const result = await transactional.transaction((tx) => {
      child.db = tx;
      return transactionStorage.run(child, operation);
    });
    parent.afterCommit.push(...child.afterCommit);
    parent.afterRollback.push(...child.afterRollback);
    return result;
  } catch (cause) {
    await dispatchAfterRollback(child.afterRollback, cause);
    throw cause;
  }
}

export function getDrizzleTransactionLocal<T>(key: object): T | undefined {
  return transactionStorage.getStore()?.locals.get(key) as T | undefined;
}

export function setDrizzleTransactionLocal<T>(key: object, value: T): boolean {
  const active = transactionStorage.getStore();
  if (!active) return false;
  active.locals.set(key, value);
  return true;
}

export function runAfterDrizzleCommit(callback: () => void | Promise<void>): boolean {
  const active = transactionStorage.getStore();
  if (!active) {
    void runOutsideDrizzleTransaction(callback);
    return false;
  }
  active.afterCommit.push(callback);
  return true;
}

/** Queue only when already inside an ambient transaction; callers run inline otherwise. */
export function deferUntilDrizzleCommit(callback: () => void | Promise<void>): boolean {
  const active = transactionStorage.getStore();
  if (!active) return false;
  active.afterCommit.push(callback);
  return true;
}

/** Queue only when already inside an ambient transaction; callers handle inline errors otherwise. */
export function deferUntilDrizzleRollback(callback: () => void | Promise<void>): boolean {
  const active = transactionStorage.getStore();
  if (!active) return false;
  active.afterRollback.push(callback);
  return true;
}

export function runOutsideDrizzleTransaction<T>(operation: () => T): T {
  return transactionStorage.exit(operation);
}

async function dispatchAfterCommit(callbacks: Array<() => void | Promise<void>>): Promise<void> {
  await Promise.allSettled(
    callbacks.map((callback) =>
      Promise.resolve().then(() => runOutsideDrizzleTransaction(() => callback())),
    ),
  );
}

async function dispatchAfterRollback(
  callbacks: Array<() => void | Promise<void>>,
  transactionCause: unknown,
): Promise<void> {
  const errors: unknown[] = [];
  for (const callback of [...callbacks].reverse()) {
    try {
      await runOutsideDrizzleTransaction(callback);
    } catch (cause) {
      errors.push(cause);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      [transactionCause, ...errors],
      "Drizzle transaction and after-rollback callbacks failed",
    );
  }
}
