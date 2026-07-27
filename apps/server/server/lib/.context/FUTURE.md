# server lib — FUTURE

- **Emit structured schema-admission refusal events.** Typed 4406/4407
  admission refusals currently appear only as unstructured `[onConnect]`
  stdout, leaving refusal volume and correlation unavailable to development
  diagnostics queries. Emit one structured, correlated event from
  `refuseConnection` in `yjs-ws-handler.ts` through the existing
  `emitEvent`/observability seam. **Affected:** `yjs-ws-handler.ts`.
