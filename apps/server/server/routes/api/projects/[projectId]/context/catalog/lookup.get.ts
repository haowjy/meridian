/** Stable-ID or canonical-path lookup over one authorized catalog scope. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler } from "nitro/h3";
import { resolveCatalogRoute } from "./_helpers.js";

export default defineEventHandler(async (event) => {
  const { app, query, scope } = await resolveCatalogRoute(event);
  const entryId = typeof query.entryId === "string" && query.entryId ? query.entryId : null;
  const path = typeof query.path === "string" && query.path ? query.path : null;
  if (Boolean(entryId) === Boolean(path)) {
    throw createError({ statusCode: 400, message: "Provide exactly one of entryId or path" });
  }
  const input = entryId
    ? ({ scope, entryId } as const)
    : ({ scope, path: path as string } as const);
  return serializeTransport(await app.contextCatalog.lookup(input));
});
