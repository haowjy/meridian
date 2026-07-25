import type { Block } from "@meridian/contracts/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/rich-content/Markdown", () => ({
  Markdown: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { TurnBlockStep } from "./TurnBlockStep";

function block(overrides: Partial<Block> = {}): Block {
  return {
    id: "block-1",
    turnId: "turn-1",
    blockType: "unknown",
    sequence: 0,
    status: "complete",
    content: null,
    textContent: null,
    ...overrides,
  } as Block;
}

describe("TurnBlockStep", () => {
  it("renders nothing for an empty unknown block", () => {
    expect(renderToStaticMarkup(<TurnBlockStep block={block()} />)).toBe("");
  });

  it("renders an unknown block when it has writer-visible content", () => {
    const html = renderToStaticMarkup(
      <TurnBlockStep block={block({ textContent: "A useful update" })} />,
    );

    expect(html).toContain("A useful update");
  });
});
