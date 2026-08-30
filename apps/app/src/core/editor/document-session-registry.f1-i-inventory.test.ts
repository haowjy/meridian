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
      /(?:\.test(?:-data|-support)?|\.typecheck|\.generated|\.gen)\.tsx?$/.test(entry.name)
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

function unalias(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!symbol) return undefined;
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function valueSymbol(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen = new Set<ts.Symbol>(),
): ts.Symbol | undefined {
  const symbol = unalias(checker, checker.getSymbolAtLocation(expression));
  if (!symbol || seen.has(symbol)) return symbol;
  seen.add(symbol);
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
    return valueSymbol(checker, declaration.initializer, seen);
  }
  if (declaration && ts.isBindingElement(declaration)) {
    const variable = declaration.parent.parent;
    if (ts.isVariableDeclaration(variable) && variable.initializer) {
      const propertyName = declaration.propertyName ?? declaration.name;
      const property = checker
        .getTypeAtLocation(variable.initializer)
        .getProperty(propertyName.getText());
      return unalias(checker, property);
    }
  }
  return symbol;
}

function symbolNamed(checker: ts.TypeChecker, expression: ts.Expression, name: string): boolean {
  return (
    valueSymbol(checker, expression)?.getName() === name ||
    checker.getTypeAtLocation(expression).getSymbol()?.getName() === name
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

function registryMemberAtCall(checker: ts.TypeChecker, expression: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expression)) {
    const symbol = unalias(checker, checker.getSymbolAtLocation(expression.name));
    return symbol && isRegistryMember(symbol) ? expression.name.text : null;
  }
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    const symbol = unalias(checker, checker.getSymbolAtLocation(expression.argumentExpression));
    return symbol && isRegistryMember(symbol) ? expression.argumentExpression.text : null;
  }
  const symbol = unalias(checker, checker.getSymbolAtLocation(expression));
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration && ts.isBindingElement(declaration)) {
    const variable = declaration.parent.parent;
    if (ts.isVariableDeclaration(variable) && variable.initializer) {
      const member = (declaration.propertyName ?? declaration.name).getText();
      const memberSymbol = checker.getTypeAtLocation(variable.initializer).getProperty(member);
      return memberSymbol && isRegistryMember(memberSymbol) ? member : null;
    }
  }
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
    return registryMemberAtCall(checker, declaration.initializer);
  }
  return null;
}

function navigatorExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen = new Set<ts.Symbol>(),
): boolean {
  expression = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(expression) && expression.text === "navigator") return true;
  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "navigator" &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "globalThis"
  )
    return true;
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteralLike(expression.argumentExpression) &&
    expression.argumentExpression.text === "navigator" &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "globalThis"
  )
    return true;
  const symbol = unalias(checker, checker.getSymbolAtLocation(expression));
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (declaration && ts.isBindingElement(declaration)) {
    const variable = declaration.parent.parent;
    const member = (declaration.propertyName ?? declaration.name).getText();
    return (
      member === "navigator" &&
      ts.isVariableDeclaration(variable) &&
      !!variable.initializer &&
      globalThisExpression(checker, variable.initializer, seen)
    );
  }
  return !!(
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    navigatorExpression(checker, declaration.initializer, seen)
  );
}

function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function globalThisExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen: Set<ts.Symbol>,
): boolean {
  expression = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(expression) && expression.text === "globalThis") return true;
  const symbol = unalias(checker, checker.getSymbolAtLocation(expression));
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return !!(
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    globalThisExpression(checker, declaration.initializer, seen)
  );
}

function navigatorLocksExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen = new Set<ts.Symbol>(),
): boolean {
  expression = unwrapTransparentExpression(expression);
  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "locks" &&
    navigatorExpression(checker, expression.expression)
  )
    return true;
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteralLike(expression.argumentExpression) &&
    expression.argumentExpression.text === "locks" &&
    navigatorExpression(checker, expression.expression)
  )
    return true;
  const symbol = unalias(checker, checker.getSymbolAtLocation(expression));
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
    return navigatorLocksExpression(checker, declaration.initializer, seen);
  }
  if (declaration && ts.isBindingElement(declaration)) {
    const variable = declaration.parent.parent;
    const member = (declaration.propertyName ?? declaration.name).getText();
    return (
      member === "locks" &&
      ts.isVariableDeclaration(variable) &&
      !!variable.initializer &&
      navigatorExpression(checker, variable.initializer)
    );
  }
  return false;
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
      if (ts.isNewExpression(node) && symbolNamed(checker, node.expression, "DocumentSession"))
        add(sourceFile, node.expression, "canonical-constructor", "DocumentSession");
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        navigatorLocksExpression(checker, node)
      )
        add(sourceFile, node, "raw-authority", "navigator.locks");
      if (
        ts.isBindingElement(node) &&
        ts.isIdentifier(node.name) &&
        navigatorLocksExpression(checker, node.name)
      )
        add(sourceFile, node, "raw-authority", "navigator.locks");
      if (ts.isStringLiteralLike(node) && node.text.includes("meridian:f1d:v1:"))
        add(sourceFile, node, "raw-authority", "meridian:f1d:v1:");
      if (
        ts.isStringLiteralLike(node) &&
        node.text.includes("document-session-registry-implementation")
      )
        add(sourceFile, node, "concrete-exposure", "document-session-registry-implementation");
      if (
        ts.isExportAssignment(node) &&
        (symbolNamed(checker, node.expression, "DocumentSessionRegistry") ||
          (ts.isIdentifier(node.expression) && node.expression.text === "DocumentSessionRegistry"))
      )
        add(sourceFile, node.expression, "concrete-exposure", "DocumentSessionRegistry");
      if (ts.isCallExpression(node)) {
        const member = registryMemberAtCall(checker, node.expression);
        if (member && LEASELESS_MEMBERS.has(member))
          add(sourceFile, node.expression, "bare-lease-less-call", "legacy-registry-call");
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
      class DocumentSession {}
      const SessionAlias = DocumentSession;
      new SessionAlias();
      const { get: acquire } = registry;
      acquire("doc");
      const { locks: lockAlias } = navigator;
      lockAlias.request("name", () => undefined);
      const elementLocks = navigator["locks"];
      elementLocks.request("name", () => undefined);
      const nav = navigator;
      const directAlias = nav.locks;
      const { locks: destructuredAlias } = nav;
      const globalNav = globalThis.navigator;
      const elementAlias = globalNav["locks"];
      export default DocumentSessionRegistry;
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
        expect.objectContaining({ kind: "canonical-constructor", line: 17 }),
        expect.objectContaining({ kind: "bare-lease-less-call", line: 19 }),
        expect.objectContaining({ kind: "raw-authority", symbol: "navigator.locks", line: 20 }),
        expect.objectContaining({ kind: "raw-authority", symbol: "navigator.locks", line: 22 }),
        expect.objectContaining({ kind: "raw-authority", symbol: "navigator.locks", line: 25 }),
        expect.objectContaining({ kind: "raw-authority", symbol: "navigator.locks", line: 26 }),
        expect.objectContaining({ kind: "raw-authority", symbol: "navigator.locks", line: 28 }),
        expect.objectContaining({ kind: "concrete-exposure", line: 29 }),
      ]),
    );
  });

  it("keeps the constructor and raw primitive owners singular", () => {
    const records = currentProductionInventory();
    expect(records.filter(({ kind }) => kind === "canonical-constructor")).toEqual([
      {
        kind: "canonical-constructor",
        symbol: "DocumentSession",
        file: "apps/app/src/core/editor/document-session-registry-implementation.ts",
        line: 713,
      },
    ]);
    expect(
      new Set(records.filter(({ kind }) => kind === "raw-authority").map(({ file }) => file)),
    ).toEqual(new Set(["apps/app/src/core/editor/document-session-cross-context-coordination.ts"]));
  });

  it("finds parenthesized, asserted, and global-destructured navigator aliases", () => {
    const records = fixtureInventory(`
      const paren = (globalThis.navigator);
      const parenLocks = paren.locks;
      const asserted = globalThis.navigator as Navigator;
      const assertedLocks = asserted["locks"];
      const { navigator: destructuredNavigator } = globalThis;
      const destructuredLocks = destructuredNavigator.locks;
      const typeAsserted = <Navigator>globalThis.navigator;
      const typeAssertedLocks = typeAsserted.locks;
      const nonNull = globalThis.navigator!;
      const nonNullLocks = nonNull.locks;
      const satisfied = globalThis.navigator satisfies Navigator;
      const satisfiedLocks = satisfied.locks;
      const globalAlias = globalThis;
      const recursiveGlobalAlias = globalAlias;
      const { navigator: recursivelyDestructuredNavigator } = recursiveGlobalAlias;
      const recursivelyDestructuredLocks = recursivelyDestructuredNavigator.locks;
    `);
    expect(
      records.filter(
        ({ kind, symbol }) => kind === "raw-authority" && symbol === "navigator.locks",
      ),
    ).toHaveLength(7);
  });
});
