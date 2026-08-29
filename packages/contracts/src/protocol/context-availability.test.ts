import { describe, expectTypeOf, it } from "vitest";

import type {
  AccessFenceKey,
  DocumentFenceKey,
  LiveDocumentSessionAuthority,
  LiveDocumentSessionLease,
} from "./context-availability.js";

describe("live document session authority contracts", () => {
  it("keeps account, project, document, and generation mandatory", () => {
    expectTypeOf<LiveDocumentSessionLease>().toEqualTypeOf<{
      accountId: string;
      projectId: string;
      documentId: string;
      generation: string;
    }>();
    expectTypeOf<DocumentFenceKey>().toMatchTypeOf<`document/${string}/${string}`>();
    expectTypeOf<AccessFenceKey>().toMatchTypeOf<`access/${string}/${string}/${string}`>();
    expectTypeOf<LiveDocumentSessionAuthority["admit"]>().parameters.toEqualTypeOf<
      [string, string, string]
    >();
  });
});
