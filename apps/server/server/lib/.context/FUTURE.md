# server lib FUTURE

## Typed admission target for the Yjs connect path

`createHocuspocus().onConnect` in `yjs-ws-handler.ts` now owns room
resolution, authorization, manifest membership, schema admission (4406/4407),
generation capture, and branch-pull scheduling, threaded through a cast-heavy
untyped Hocuspocus context bag. Flagged by the S2 schema-fence wire probe
(spawn p4835) as responsibility accretion.

**Proposed direction:** resolve one typed admission target (documentId, room
kind, head schema version, generations) up front, then apply a single
admission policy over it; give the gateway context an explicit typed contract
instead of `Record<string, unknown>` casts.

**Affected paths:** `yjs-ws-handler.ts` (primary), `routes/ws/yjs.ts`
(context construction).

## Structured events for schema admission refusals

Typed admission refusals (4406/4407) currently appear only as unstructured
`[onConnect]` stdout — no `EventSink` record exists, so refusal volume and
correlation are invisible to dev diagnostics queries. Flagged by the Gate-1
runtime probe (spawn p4854).

**Proposed direction:** emit one structured, correlated event from
`refuseConnection` (`yjs-ws-handler.ts`) through the existing
`emitEvent`/observability seam.

**Affected paths:** `yjs-ws-handler.ts`.
