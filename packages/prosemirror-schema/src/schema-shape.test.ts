/** Snapshot and bump-class gate for the collaboration schema surface. */
import type { Attrs, MarkSpec, NodeSpec } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  documentMarks,
  documentNodes,
  PROSEMIRROR_FRAGMENT_NAME,
} from "./index.js";
import snapshot from "./schema-shape.snapshot.json";

const POLICY = "packages/prosemirror-schema/AGENTS.md#schema-version-bump-policy";

type AttributeSurface = {
  hasDefault: boolean;
  default?: unknown;
};

type TypeSurface = {
  attrs: Record<string, AttributeSurface>;
  content: string | null;
};

type SchemaSurface = {
  fragmentName: string;
  nodes: Record<string, TypeSurface>;
  marks: Record<string, TypeSurface>;
};

type SchemaShapeSnapshot = {
  version: CollabSchemaVersion;
  surface: SchemaSurface;
};

type BumpClass = "none" | "minor" | "major";

function attributeSurface(attrs: Attrs | undefined): Record<string, AttributeSurface> {
  return Object.fromEntries(
    Object.entries(attrs ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, spec]) => [
        name,
        "default" in spec ? { hasDefault: true, default: spec.default } : { hasDefault: false },
      ]),
  );
}

function typeSurface(specs: Record<string, NodeSpec | MarkSpec>): Record<string, TypeSurface> {
  return Object.fromEntries(
    Object.entries(specs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, spec]) => [
        name,
        {
          attrs: attributeSurface(spec.attrs),
          content: "content" in spec ? (spec.content ?? null) : null,
        },
      ]),
  );
}

function currentSurface(): SchemaSurface {
  return {
    fragmentName: PROSEMIRROR_FRAGMENT_NAME,
    nodes: typeSurface(documentNodes),
    marks: typeSurface(documentMarks),
  };
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function classifyTypeMap(
  previous: Record<string, TypeSurface>,
  current: Record<string, TypeSurface>,
): BumpClass {
  let result: BumpClass = "none";
  for (const [name, previousType] of Object.entries(previous)) {
    const currentType = current[name];
    if (!currentType) return "major";
    if (previousType.content !== currentType.content) result = "minor";
    for (const [attrName, previousAttr] of Object.entries(previousType.attrs)) {
      const currentAttr = currentType.attrs[attrName];
      if (!currentAttr) return "major";
      if (!equal(previousAttr, currentAttr)) result = "minor";
    }
    for (const [attrName, currentAttr] of Object.entries(currentType.attrs)) {
      if (attrName in previousType.attrs) continue;
      if (!currentAttr.hasDefault) return "major";
      result = "minor";
    }
  }
  if (Object.keys(current).some((name) => !(name in previous))) result = "minor";
  return result;
}

function maxBump(a: BumpClass, b: BumpClass): BumpClass {
  if (a === "major" || b === "major") return "major";
  if (a === "minor" || b === "minor") return "minor";
  return "none";
}

function classifySurfaceChange(previous: SchemaSurface, current: SchemaSurface): BumpClass {
  if (previous.fragmentName !== current.fragmentName) return "major";
  return maxBump(
    classifyTypeMap(previous.nodes, current.nodes),
    classifyTypeMap(previous.marks, current.marks),
  );
}

function validateBump(
  previous: CollabSchemaVersion,
  current: CollabSchemaVersion,
  bump: BumpClass,
): void {
  if (bump === "none") {
    if (!equal(previous, current)) {
      throw new Error("An identical schema surface requires the snapshot version to be updated.");
    }
    return;
  }
  if (bump === "minor") {
    if (
      current.major !== previous.major ||
      current.minor !== previous.minor + 1 ||
      current.patch !== 0
    ) {
      throw new Error("Additive schema surface changes require an x.(y+1).0 version bump.");
    }
    return;
  }
  if (current.major !== previous.major + 1 || current.minor !== 0 || current.patch !== 0) {
    throw new Error(
      `Removing or renaming schema surface, changing the fragment name, or changing Yjs encoding requires a major bump, human ruling, and migration plan. See ${POLICY}.`,
    );
  }
}

const baseline = snapshot as SchemaShapeSnapshot;

describe("collaboration schema shape", () => {
  it("matches the recorded surface and version", () => {
    const surface = currentSurface();
    const bump = classifySurfaceChange(baseline.surface, surface);
    validateBump(baseline.version, COLLAB_SCHEMA_VERSION, bump);
    expect(surface).toEqual(baseline.surface);
  });

  it("permits an identical surface without a bump", () => {
    expect(classifySurfaceChange(baseline.surface, baseline.surface)).toBe("none");
    expect(() => validateBump(baseline.version, baseline.version, "none")).not.toThrow();
  });

  it("requires a minor bump for a new type or defaulted attribute", () => {
    const addedType: SchemaSurface = structuredClone(baseline.surface);
    addedType.nodes.callout = { attrs: {}, content: "block+" };
    expect(classifySurfaceChange(baseline.surface, addedType)).toBe("minor");

    const addedAttr: SchemaSurface = structuredClone(baseline.surface);
    addedAttr.nodes.paragraph.attrs.variant = { hasDefault: true, default: null };
    expect(classifySurfaceChange(baseline.surface, addedAttr)).toBe("minor");
    expect(() =>
      validateBump(
        baseline.version,
        { major: baseline.version.major, minor: baseline.version.minor + 1, patch: 0 },
        "minor",
      ),
    ).not.toThrow();
    expect(() => validateBump(baseline.version, baseline.version, "minor")).toThrow("x.(y+1).0");
  });

  it("requires at least the minor path for content and default mutations", () => {
    const contentChanged: SchemaSurface = structuredClone(baseline.surface);
    contentChanged.nodes.paragraph.content = "inline+";
    expect(classifySurfaceChange(baseline.surface, contentChanged)).toBe("minor");

    const defaultChanged: SchemaSurface = structuredClone(baseline.surface);
    defaultChanged.nodes.heading.attrs.level.default = 2;
    expect(classifySurfaceChange(baseline.surface, defaultChanged)).toBe("minor");
    expect(() => validateBump(baseline.version, baseline.version, "minor")).toThrow("x.(y+1).0");
  });

  it.each([
    "node",
    "mark",
    "attribute",
    "fragment",
  ] as const)("hard-fails a removed or renamed %s without a policy-linked major bump", (kind) => {
    const changed: SchemaSurface = structuredClone(baseline.surface);
    if (kind === "node") delete changed.nodes.paragraph;
    if (kind === "mark") delete changed.marks.strong;
    if (kind === "attribute") delete changed.nodes.heading.attrs.level;
    if (kind === "fragment") changed.fragmentName = "renamed";

    expect(classifySurfaceChange(baseline.surface, changed)).toBe("major");
    expect(() => validateBump(baseline.version, baseline.version, "major")).toThrow(POLICY);
    expect(() =>
      validateBump(
        baseline.version,
        { major: baseline.version.major + 1, minor: 0, patch: 0 },
        "major",
      ),
    ).not.toThrow();
  });
});
