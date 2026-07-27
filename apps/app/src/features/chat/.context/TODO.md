# Chat TODO

## Grep excerpts leak block hashes

Grep match snippets in tool expands render the raw `hash|text` prefix from
the read pipeline (e.g. `79b9|The hollow gate stood…`). Writer-visible
today. Fix belongs to the excerpt-rendering slices (5/6) of the activity
timeline design package — strip the hash before display.

## Composer-backed ask_user interrupts

`ask_user` interrupts currently render as inline component cards through
`ChoiceBlock`, `TextBlock`, `FormBlock`, and `ComponentResolvedSummary`.

The better direction is to treat an interrupt as a temporary composer mode: the
question and answer controls should sit on or replace the composer surface,
rather than rendering a bulky card in the transcript. Resolved answers should
read as compact conversational receipts.

Track with GitHub issue: #130.

## Composer `@ for reference` rotation hint

When mentions land, append ", @ for reference" to the rotating composer
placeholder when the writer has not used `@` in seven days. Drive it from the
real mention last-use timestamp rather than a disabled placeholder path.
