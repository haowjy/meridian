/** Keeps the deferred F1-I caller inventory exact without banning the private bridge early. */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { F1_I_DOCUMENT_SESSION_INVENTORY } from "./document-session-registry.f1-i-inventory.test-data";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test(?:-data)?\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

function productionMatches(
  appRoot: string,
  pattern: RegExp,
): Array<{ file: string; count: number }> {
  return sourceFiles(join(appRoot, "src"))
    .filter((path) => !path.endsWith(".typecheck.ts"))
    .flatMap((path) => {
      const count = [...readFileSync(path, "utf8").matchAll(pattern)].length;
      return count
        ? [{ file: `apps/app/${relative(appRoot, path).split(sep).join("/")}`, count }]
        : [];
    })
    .sort((left, right) => left.file.localeCompare(right.file));
}

describe("F1-I document-session deletion inventory", () => {
  it("lists every production facade importer exactly", () => {
    const appRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
    const callers = sourceFiles(join(appRoot, "src"))
      .filter((path) =>
        /import\s+\{[^}]*getDocumentSessionRegistry[^}]*\}\s+from/.test(readFileSync(path, "utf8")),
      )
      .map((path) => `apps/app/${relative(appRoot, path).split(sep).join("/")}`)
      .sort();

    expect(callers).toEqual([...F1_I_DOCUMENT_SESSION_INVENTORY.productionCallers].sort());
  });

  it("freezes every transitional definition/reference and authority bypass", () => {
    const appRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
    expect(productionMatches(appRoot, /\btemporary[A-Z][A-Za-z0-9_]*/g)).toEqual([
      { file: "apps/app/src/core/editor/document-session-registry-implementation.ts", count: 15 },
      { file: "apps/app/src/core/editor/document-session-registry.ts", count: 17 },
    ]);
    expect(productionMatches(appRoot, /\.(?:revokeRoom|destroyRoom)\s*\(/g)).toEqual([
      {
        file: "apps/app/src/features/project/context/untitled-reconciler.ts",
        count: 1,
      },
      {
        file: "apps/app/src/features/project/context/useCatalogWorkingSetReconciler.ts",
        count: 2,
      },
      { file: "apps/app/src/features/project/ContextPaneController.tsx", count: 1 },
    ]);
    expect(
      productionMatches(
        appRoot,
        /\broomSessionPersistenceKey\b|\buseCatalogWorkingSetReconciler\b/g,
      ),
    ).toEqual([
      { file: "apps/app/src/core/editor/document-session.ts", count: 2 },
      {
        file: "apps/app/src/features/project/context/useCatalogWorkingSetReconciler.ts",
        count: 1,
      },
      { file: "apps/app/src/features/project/ProjectView.tsx", count: 3 },
    ]);
    expect(productionMatches(appRoot, /new\s+DocumentSession\s*\(/g)).toEqual([
      {
        file: "apps/app/src/core/editor/document-session-registry-implementation.ts",
        count: 1,
      },
    ]);
    expect(
      productionMatches(
        appRoot,
        /navigator\.locks|new\s+BroadcastChannel|LockManager|meridian:f1d:v1:/g,
      ),
    ).toEqual([
      {
        file: "apps/app/src/core/editor/document-session-cross-context-coordination.ts",
        count: 7,
      },
    ]);
    expect(
      productionMatches(appRoot, /from\s+["'][^"']*document-session-registry-implementation["']/g),
    ).toEqual([{ file: "apps/app/src/core/editor/document-session-registry.ts", count: 1 }]);
  });
});
