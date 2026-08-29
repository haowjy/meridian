/** Syntax-aware, line-exact inventory for deleting the temporary F1-I session ingress. */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { F1_I_DOCUMENT_SESSION_INVENTORY } from "./document-session-registry.f1-i-inventory.test-data";

type InventoryRecord = { kind: string; symbol: string; file: string; line: number };

const TRANSITIONAL = new Set([
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
]);
const LEGACY_MEMBERS = new Set(["revokeRoom", "destroyRoom"]);
const UNQUALIFIED = new Set(["roomSessionPersistenceKey", "useCatalogWorkingSetReconciler"]);
const LEASELESS_MEMBERS = new Set([
  "get",
  "getDetached",
  "attachDetached",
  "restartUnavailableRoom",
  "retain",
]);
const RAW_TYPES = new Set(["BroadcastChannel", "CrossContextLockManager", "LockManager"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : sourceFiles(path);
    if (
      !/\.tsx?$/.test(entry.name) ||
      /(?:\.test(?:-data)?|\.typecheck|\.generated|\.gen)\.tsx?$/.test(entry.name)
    )
      return [];
    return [path];
  });
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function facadeKind(identifier: ts.Identifier): string {
  let node: ts.Node | undefined = identifier;
  while (node && !ts.isSourceFile(node)) {
    if (ts.isImportDeclaration(node)) return "facade-import";
    if (ts.isExportDeclaration(node)) return "facade-re-export";
    node = node.parent;
  }
  if (ts.isFunctionDeclaration(identifier.parent) && identifier.parent.name === identifier)
    return "facade-definition";
  return "facade-reference";
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function isRegistryMember(symbol: ts.Symbol | undefined): boolean {
  return !!symbol?.declarations?.some((declaration) => {
    let current: ts.Node | undefined = declaration;
    while (current) {
      if (
        ts.isTypeAliasDeclaration(current) &&
        current.name.text === "TemporaryUnfencedDocumentSessionRegistry"
      )
        return true;
      current = current.parent;
    }
    return false;
  });
}

function scanProgram(program: ts.Program, appRoot: string): InventoryRecord[] {
  const checker = program.getTypeChecker();
  const records: InventoryRecord[] = [];
  const add = (sourceFile: ts.SourceFile, node: ts.Node, kind: string, symbol: string) => {
    const fileName = sourceFile.fileName;
    const file = fileName.startsWith(appRoot)
      ? `apps/app/${relative(appRoot, fileName).split(sep).join("/")}`
      : fileName;
    records.push({ kind, symbol, file, line: lineOf(sourceFile, node) });
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (!program.getRootFileNames().includes(sourceFile.fileName)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const name = node.text;
        if (TRANSITIONAL.has(name)) {
          add(sourceFile, node, "transitional", name);
          if (name === "getDocumentSessionRegistry") add(sourceFile, node, facadeKind(node), name);
        }
        if (LEGACY_MEMBERS.has(name)) add(sourceFile, node, "legacy-owner", name);
        if (UNQUALIFIED.has(name)) add(sourceFile, node, "unqualified-owner", name);
        if (RAW_TYPES.has(name)) add(sourceFile, node, "raw-authority", name);
        if (
          name === "DocumentSessionRegistry" &&
          ((ts.isClassDeclaration(node.parent) && isExported(node.parent)) ||
            ts.isExportSpecifier(node.parent))
        )
          add(sourceFile, node, "concrete-exposure", name);
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "DocumentSession"
      )
        add(sourceFile, node.expression, "canonical-constructor", "DocumentSession");
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "navigator" &&
        node.name.text === "locks"
      )
        add(sourceFile, node, "raw-authority", "navigator.locks");
      if (ts.isStringLiteralLike(node) && node.text.includes("meridian:f1d:v1:"))
        add(sourceFile, node, "raw-authority", "meridian:f1d:v1:");
      if (
        ts.isStringLiteralLike(node) &&
        node.text.includes("document-session-registry-implementation")
      )
        add(sourceFile, node, "concrete-exposure", "document-session-registry-implementation");
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const member = node.expression.name;
        if (
          LEASELESS_MEMBERS.has(member.text) &&
          isRegistryMember(checker.getSymbolAtLocation(member))
        )
          add(sourceFile, member, "bare-lease-less-call", "legacy-registry-call");
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
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

function productionInventory(appRoot: string): InventoryRecord[] {
  const files = sourceFiles(join(appRoot, "src"));
  const config = ts.getParsedCommandLineOfConfigFile(
    join(appRoot, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (!config) throw new Error("Unable to read app TypeScript configuration");
  return scanProgram(ts.createProgram(files, config.options), appRoot);
}

function fixtureInventory(source: string): InventoryRecord[] {
  const fileName = "/fixture.ts";
  const host = ts.createCompilerHost({ target: ts.ScriptTarget.ESNext });
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion) =>
    name === fileName
      ? ts.createSourceFile(name, source, languageVersion, true, ts.ScriptKind.TS)
      : original(name, languageVersion);
  host.readFile = (name) => (name === fileName ? source : readFileSync(name, "utf8"));
  host.fileExists = (name) => name === fileName || ts.sys.fileExists(name);
  return scanProgram(ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext }, host), "/");
}

const appRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
let cachedProductionInventory: InventoryRecord[] | undefined;
function currentProductionInventory(): InventoryRecord[] {
  cachedProductionInventory ??= productionInventory(appRoot);
  return cachedProductionInventory;
}

describe("F1-I document-session deletion inventory", () => {
  it("matches the complete line-exact production inventory", () => {
    expect(currentProductionInventory()).toEqual(F1_I_DOCUMENT_SESSION_INVENTORY.expectedRecords);
  }, 20_000);

  it("cannot hide frozen syntax behind aliases, destructuring, multiline exports, or DOM types", () => {
    const records = fixtureInventory(`
      type TemporaryUnfencedDocumentSessionRegistry = { get(id: string): unknown; revokeRoom(id: string): void };
      declare const registry: TemporaryUnfencedDocumentSessionRegistry;
      const alias = registry;
      alias.get("doc");
      const { revokeRoom } = alias;
      import {
        getDocumentSessionRegistry as facade
      } from "./document-session-registry";
      export {
        facade as getDocumentSessionRegistry
      };
      const locks: LockManager | null = navigator.locks;
      export { DocumentSessionRegistry };
    `);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "bare-lease-less-call", line: 5 }),
        expect.objectContaining({ kind: "legacy-owner", symbol: "revokeRoom", line: 6 }),
        expect.objectContaining({ kind: "facade-import", line: 8 }),
        expect.objectContaining({ kind: "facade-re-export", line: 11 }),
        expect.objectContaining({ kind: "raw-authority", symbol: "LockManager", line: 13 }),
        expect.objectContaining({ kind: "raw-authority", symbol: "navigator.locks", line: 13 }),
        expect.objectContaining({ kind: "concrete-exposure", line: 14 }),
      ]),
    );
  });

  it("keeps the constructor and raw primitive owners singular", () => {
    const records = currentProductionInventory();
    expect(
      new Set(
        records.filter(({ kind }) => kind === "canonical-constructor").map(({ file }) => file),
      ),
    ).toEqual(new Set(["apps/app/src/core/editor/document-session-registry-implementation.ts"]));
    expect(
      new Set(records.filter(({ kind }) => kind === "raw-authority").map(({ file }) => file)),
    ).toEqual(new Set(["apps/app/src/core/editor/document-session-cross-context-coordination.ts"]));
  });
});
