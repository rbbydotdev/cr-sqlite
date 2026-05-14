# FugueOnCRSqlite TLA+ spec

This directory holds a TLA+ specification of the "Option 3 atomic-row"
protocol for a Fugue text CRDT layered on top of cr-sqlite. It is intended
to be checked with TLC, the explicit-state TLA+ model checker.

## What it models

Each Fugue node is one row in a backing SQLite table with columns
`(itemId, idx, content, parentItemId, parentIdx, tombstoned)`. The
protocol restricts writes to exactly two shapes:

1. An atomic `INSERT` that sets every column at once.
2. An optional single-cell `UPDATE` that flips `tombstoned` from 0 to 1.

Rows are shipped between peers via cr-sqlite's per-peer FIFO transport
(modeled as one ordered channel per `(from, to)` peer pair). The
specification deliberately abstracts:

- Fugue tie-break rules: `Render` is defined as a pure function of the
  row set so any conforming Fugue implementation satisfies Strong
  Convergence.
- The SQL layer itself: once we accept atomic-row delivery as a
  premise, the actual SQL plumbing is irrelevant.
- Network partitions and multi-document state: a single document is
  modeled and sync either happens or does not on each non-deterministic
  step. Fairness on the `Deliver` action gives the standard
  "eventually-delivered" property.

The spec lives in `FugueOnCRSqlite.tla`; TLC configuration is in
`FugueOnCRSqlite.cfg`.

## Running TLC

TLC is distributed as a single jar. This directory ships with one at
`tools/tla2tools.jar` already (download fresh from
<https://github.com/tlaplus/tlaplus/releases> if you need to update it).

The convenience script `run-tlc.sh` invokes TLC with sensible defaults:

```bash
./run-tlc.sh                       # 4 workers, 4G heap
./run-tlc.sh -workers 8            # extra args are passed through to TLC
WORKERS=8 HEAP=8G ./run-tlc.sh     # env overrides
```

To run TLC directly:

```bash
java -XX:+UseParallelGC -cp tools/tla2tools.jar tlc2.TLC \
     -workers 4 -config FugueOnCRSqlite.cfg FugueOnCRSqlite.tla
```

For deeper checks raise `MaxOps` in the cfg.

Tool versions: TLA+ tools 1.8+ (TLC v2.18+) are recommended. Older TLC
versions will accept the syntax but may be slower.

## Properties checked

State invariants (checked at every reachable state):

| Invariant | Meaning |
| --- | --- |
| `TypeOK` | All variables stay within their declared types. Catches modelling slips. |
| `AtomicityInvariant` | If two peers both have a row with the same `itemId`, every non-tombstone column agrees. This is the safety consequence of atomic-row delivery. |
| `StrongConvergence` | Equal row sets render identically. Trivially true because `Render` is a pure function of `rows`; the check confirms no peer-local state has leaked into rendering. |
| `NoOrphanReads` | Every visible row has a valid parent in the row set. `VisibleRows` enforces this by construction. |
| `QuiescentAgreement` | If all channels are empty, peers agree on their row sets. |

Temporal properties (checked over whole behaviours):

| Property | Meaning |
| --- | --- |
| `TombstoneMonotonicityProp` | Once a peer sees an `itemId` tombstoned, no subsequent state at that peer shows it as live. |
| `EventualConsistency` | `OpsExhausted ~> AllAgree`. Once we stop issuing operations, fair delivery converges all peers. |

## Interpreting counterexamples

If TLC reports a violation, it prints a behaviour: a sequence of
`(state, action)` pairs. Read it as follows.

- **`AtomicityInvariant` violation**: two peers ended up with rows that
  share an `itemId` but differ in a non-tombstone column. This would
  mean some action *other than* `Insert`/`Tombstone` modified a row, or
  `ApplyOne` overrode a stable field. In the real implementation that
  corresponds to a stray per-cell UPDATE leaking through cr-sqlite.

- **`StrongConvergence` violation**: should never fire because `Render`
  is a pure function in the model. If it does, the model has an
  expression accidentally referencing peer-local state inside `Render`.

- **`NoOrphanReads` violation**: `Render` surfaced a row whose parent
  cannot be resolved. This is a guard the renderer must implement
  defensively; the model proves the guard is necessary in concurrent
  scenarios where a child is delivered before its parent.

- **`QuiescentAgreement` violation**: peers' channels are all empty but
  their row sets differ. Either the `Deliver` merge logic is wrong, or
  some change escaped the channel system.

- **`TombstoneMonotonicityProp` violation**: a peer flipped a row back
  from tombstoned to live. Should never happen given `ApplyOne` uses
  max-merge on the tombstone flag.

- **`EventualConsistency` violation**: even after `opsCount = MaxOps`,
  some `(from, to)` pair fails to drain, leaving peers permanently
  divergent. Investigate the `Fairness` clause.

## Modeling decisions and what they DO NOT prove

- The Fugue *positional* ordering is not modeled. `idx` values are
  picked from a small finite range with no ordering constraints. The
  spec therefore proves nothing about Fugue's specific tree shape,
  only that the storage substrate preserves whatever shape Fugue
  computes.
- Only `(itemId, idx, content, parentItemId, parentIdx)` are frozen
  fields. Adding more columns (e.g. author, timestamp) needs them
  added to `AtomicityInvariant` and to `Row`.
- `MaxOps = 3` is small. It is sufficient to exercise the merge logic
  in the presence of concurrent insertions and tombstones across three
  peers, but is not a substitute for property-based fuzzing against
  the real implementation.
- The spec does not model *crash recovery* or *cr-sqlite clock
  divergence*. It assumes cr-sqlite hands every change exactly once to
  every peer in source order. If that assumption is wrong in practice
  (e.g. duplicate delivery, dropped change), the spec's results do not
  apply.
- The state space is finite and small by design. TLC explores every
  reachable interleaving up to `MaxOps`. With three peers and
  `MaxOps = 3`, the model has thousands to low millions of states and
  should complete in seconds to a minute. With `MaxOps = 4` expect
  longer; with `MaxOps = 5` consider enabling state-space reduction or
  using TLC's `-fp` flag for fingerprint-based dedup.

## File layout

```
FugueOnCRSqlite.tla   the specification
FugueOnCRSqlite.cfg   TLC configuration (constants, invariants, properties)
README.md             this file
```
