/** Executable, line-exact inventory for deleting the temporary F1-I session ingress. */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { F1_I_DOCUMENT_SESSION_INVENTORY } from "./document-session-registry.f1-i-inventory.test-data";

type InventoryRecord = { kind: string; symbol: string; file: string; line: number };

const TRANSITIONAL = [
  "TemporaryUnfencedDocumentSessionRegistry",
  "getDocumentSessionRegistry",
  "temporaryGet",
  "temporaryGetDetached",
  "temporaryAttachDetached",
  "temporaryRestartUnavailableRoom",
  "temporaryRetain",
  "temporaryRelease",
  "temporaryPeek",
  "temporaryRevokeRoom",
  "temporaryObserve",
  "temporaryGetLive",
] as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test(?:-data)?\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

function addMatches(
  records: InventoryRecord[],
  file: string,
  lines: readonly string[],
  kind: string,
  symbol: string,
  pattern: RegExp,
): void {
  for (const [index, line] of lines.entries()) {
    pattern.lastIndex = 0;
    const matches = [...line.matchAll(pattern)];
    for (let occurrence = 0; occurrence < matches.length; occurrence += 1)
      records.push({ kind, symbol, file, line: index + 1 });
  }
}

function productionInventory(appRoot: string): InventoryRecord[] {
  const records: InventoryRecord[] = [];
  for (const path of sourceFiles(join(appRoot, "src")).filter(
    (candidate) => !candidate.endsWith(".typecheck.ts"),
  )) {
    const file = `apps/app/${relative(appRoot, path).split(sep).join("/")}`;
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    for (const symbol of TRANSITIONAL)
      addMatches(records, file, lines, "transitional", symbol, new RegExp(`\\b${symbol}\\b`, "g"));
    for (const [index, line] of lines.entries()) {
      if (!/\bgetDocumentSessionRegistry\b/.test(line)) continue;
      const kind = /^\s*import\b/.test(line)
        ? "facade-import"
        : /^\s*export\s+(?:async\s+)?function\b/.test(line)
          ? "facade-definition"
          : /^\s*export\b.*\bfrom\b/.test(line)
            ? "facade-re-export"
            : "facade-reference";
      records.push({ kind, symbol: "getDocumentSessionRegistry", file, line: index + 1 });
    }
    addMatches(records, file, lines, "legacy-owner", "revokeRoom", /\.revokeRoom\b/g);
    addMatches(records, file, lines, "legacy-owner", "destroyRoom", /\.destroyRoom\b/g);
    addMatches(
      records,
      file,
      lines,
      "unqualified-owner",
      "roomSessionPersistenceKey",
      /\broomSessionPersistenceKey\b/g,
    );
    addMatches(
      records,
      file,
      lines,
      "unqualified-owner",
      "useCatalogWorkingSetReconciler",
      /\buseCatalogWorkingSetReconciler\b/g,
    );
    addMatches(
      records,
      file,
      lines,
      "canonical-constructor",
      "DocumentSession",
      /new\s+DocumentSession\b/g,
    );
    addMatches(records, file, lines, "raw-authority", "navigator.locks", /navigator\.locks\b/g);
    addMatches(records, file, lines, "raw-authority", "BroadcastChannel", /\bBroadcastChannel\b/g);
    addMatches(
      records,
      file,
      lines,
      "raw-authority",
      "CrossContextLockManager",
      /\bCrossContextLockManager\b/g,
    );
    addMatches(records, file, lines, "raw-authority", "meridian:f1d:v1:", /meridian:f1d:v1:/g);
    addMatches(
      records,
      file,
      lines,
      "concrete-exposure",
      "document-session-registry-implementation",
      /document-session-registry-implementation/g,
    );
    addMatches(
      records,
      file,
      lines,
      "bare-lease-less-call",
      "legacy-registry-call",
      /\b(?:registry|sessionRegistry|documentSessionRegistry)\.(?:get|getDetached|attachDetached|restartUnavailableRoom|retain)\s*\(/g,
    );
  }
  const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  return records.sort(
    (left, right) =>
      compare(left.kind, right.kind) ||
      compare(left.symbol, right.symbol) ||
      compare(left.file, right.file) ||
      left.line - right.line,
  );
}

describe("F1-I document-session deletion inventory", () => {
  it("matches the complete line-exact production inventory", () => {
    const appRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
    expect(productionInventory(appRoot)).toEqual(F1_I_DOCUMENT_SESSION_INVENTORY.expectedRecords);
  });
});
