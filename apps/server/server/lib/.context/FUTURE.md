# server lib — FUTURE

- **Type the Yjs connection-admission target.** `createHocuspocus().onConnect`
  in `yjs-ws-handler.ts` currently resolves the room, authorization, manifest
  membership, schema admission (4406/4407), generation capture, and
  branch-pull scheduling through a cast-heavy untyped Hocuspocus context bag.
  Resolve one typed target (document ID, room kind, head schema version, and
  generations) up front, then apply one admission policy to it; give the
  gateway context an explicit type instead of `Record<string, unknown>` casts.
  **Affected:** `yjs-ws-handler.ts` (primary), `routes/ws/yjs.ts` (context
  construction).
- **Emit structured schema-admission refusal events.** Typed 4406/4407
  admission refusals currently appear only as unstructured `[onConnect]`
  stdout, leaving refusal volume and correlation unavailable to development
  diagnostics queries. Emit one structured, correlated event from
  `refuseConnection` in `yjs-ws-handler.ts` through the existing
  `emitEvent`/observability seam. **Affected:** `yjs-ws-handler.ts`.
