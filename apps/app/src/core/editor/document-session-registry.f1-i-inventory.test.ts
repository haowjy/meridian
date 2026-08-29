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

  it("makes the future symbol, pattern, and compile-negative gates explicit", () => {
    expect(F1_I_DOCUMENT_SESSION_INVENTORY.symbolsToDelete).toContain(
      "TemporaryUnfencedDocumentSessionRegistry",
    );
    expect(F1_I_DOCUMENT_SESSION_INVENTORY.negativeSpacePatterns).toEqual(
      expect.arrayContaining([
        "getDocumentSessionRegistry",
        "revokeRoom\\(",
        "destroyRoom\\(",
        "new DocumentSession\\(",
        "roomSessionPersistenceKey",
        "useCatalogWorkingSetReconciler",
      ]),
    );
    expect(F1_I_DOCUMENT_SESSION_INVENTORY.compileNegativeBareCalls).toHaveLength(5);
  });
});
