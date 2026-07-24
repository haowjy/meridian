import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HelperResultBlock } from "./HelperResultBlock";

const content = {
  kind: "helper-result",
  props: {
    agentSlug: "story-editor",
    agentName: "Story Editor",
    status: "completed",
    summary: "",
    childThreadId: "thread-child",
    parentTurnId: "turn-parent",
  },
};

describe("HelperResultBlock", () => {
  it("renders an agent name only once when there is no distinct title", () => {
    const html = renderToStaticMarkup(
      <HelperResultBlock content={content} respond={() => {}} isAwaitingResponse={false} />,
    );

    expect(html.match(/Story Editor/g)).toHaveLength(1);
  });

  it("renders a distinct secondary title", () => {
    const html = renderToStaticMarkup(
      <HelperResultBlock
        content={{ ...content, props: { ...content.props, title: "Continuity review" } }}
        respond={() => {}}
        isAwaitingResponse={false}
      />,
    );

    expect(html).toContain("Story Editor");
    expect(html).toContain("Continuity review");
  });
});
