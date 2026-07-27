// @vitest-environment jsdom
/** Writer-copy contract for the minimal schema-fence notice. */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { SchemaFenceNotice } = await import("./SchemaFenceNotice");

describe("SchemaFenceNotice", () => {
  it.each([
    [
      "client-superseded",
      "This chapter was opened in a newer version of Meridian. Refresh to keep writing.",
    ],
    [
      "invalid-content",
      "Part of this chapter can't be opened safely in this version of Meridian. Editing is paused to protect your manuscript. Refresh to try again.",
    ],
    [
      "repair-detected",
      "Part of this chapter couldn't be kept in this version of Meridian. Editing is paused to protect your manuscript. Refresh to continue.",
    ],
  ] as const)("renders the %s writer copy without surface styling", (reason, copy) => {
    const html = renderToStaticMarkup(<SchemaFenceNotice fence={{ reason }} />);
    const container = document.createElement("div");
    container.innerHTML = html;

    expect(html).toContain("data-schema-fence");
    expect(html).toContain(`data-schema-fence-reason="${reason}"`);
    expect(container.textContent).toBe(copy);
    expect(html).not.toContain("class=");
  });
});
