------------------------- MODULE FugueOnCRSqlite -------------------------
(***************************************************************************)
(* TLA+ specification of the "Option 3 atomic-row" protocol for a Fugue    *)
(* text CRDT layered on top of cr-sqlite.                                  *)
(*                                                                         *)
(* Each Fugue node is exactly one row in a backing SQLite table. Rows are  *)
(* written at most twice in their lifetime:                                *)
(*                                                                         *)
(*   1. An atomic INSERT that sets every column at once                    *)
(*      (itemId, idx, content, parentItemId, parentIdx, tombstoned=0)      *)
(*                                                                         *)
(*   2. An optional single-cell UPDATE that flips tombstoned 0 -> 1        *)
(*                                                                         *)
(* No other column-level UPDATEs are permitted. This is the "atomic-row"   *)
(* invariant. The motivating bug is that cr-sqlite's per-cell CRR transport*)
(* delivers cells one at a time, so any cross-column UPDATE would let a    *)
(* peer observe a torn row (e.g. parentIdx already moved but parentItemId  *)
(* not yet). By only ever shipping whole rows on insert plus one tombstone *)
(* cell on delete, we eliminate the torn-row failure mode.                 *)
(*                                                                         *)
(* This spec is deliberately abstract:                                     *)
(*   - Fugue tie-break rules are encapsulated inside an opaque Render      *)
(*     function. We only require Render to be a pure function of the row  *)
(*     set, which is enough for Strong Convergence.                        *)
(*   - The SQL layer, network partitions, and message reordering across   *)
(*     peers are not modeled; cr-sqlite is assumed to preserve causality  *)
(*     of changes shipped from a single peer (per-peer FIFO).             *)
(*   - A single document is modeled. Multiple documents add no            *)
(*     interesting state for the questions we want to answer.             *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, Sequences, TLC

CONSTANTS
    Peers,        \* finite set of peer ids, e.g. {p1, p2, p3}
    MaxOps        \* upper bound on total Insert+Tombstone operations

\* ---------------------------------------------------------------------------
\* Identifiers
\* ---------------------------------------------------------------------------
\* itemIds are abstract opaque tokens. In a real implementation they would be
\* (peer, counter) Lamport pairs; for TLC we enumerate them as <<peer, n>>
\* pairs. RootId is the sentinel root that every document has; it is not
\* stored as a row, it is the parent reference used by top-level inserts.
\*
\* RootId is a tuple so that ItemIds \cup {RootId} is a homogeneously-typed
\* set (TLC can't compare strings and tuples for equality). We use a peer
\* slot of "ROOT" and counter 0, which can never collide with a real itemId
\* (real ones use Peers and counters >= 1).
RootId == <<"ROOT", 0>>

\* Pool of itemIds large enough to cover any execution within MaxOps.
ItemIds == { <<p, n>> : p \in Peers, n \in 1..MaxOps }

\* Idx is the Fugue positional component. Small finite range; concrete values
\* don't matter for the safety properties we check, so we keep it tight.
Idxs == 0..2

\* Content alphabet. Two letters are enough to distinguish renders.
Content == {"a", "b"}

\* ---------------------------------------------------------------------------
\* Row record schema
\* ---------------------------------------------------------------------------
\* itemId       : unique identity of the Fugue node
\* idx          : Fugue position component
\* content      : payload character
\* parentItemId : parent node's itemId, or RootId
\* parentIdx    : parent node's idx (0 if RootId)
\* tombstoned   : 0 or 1
Row ==
    [ itemId       : ItemIds,
      idx          : Idxs,
      content      : Content,
      parentItemId : ItemIds \cup {RootId},
      parentIdx    : Idxs,
      tombstoned   : {0, 1} ]

\* ---------------------------------------------------------------------------
\* Variables
\* ---------------------------------------------------------------------------
\* rows[p]          : set of rows materialised on peer p
\* channel[<<f,t>>] : FIFO queue of rows peer f still needs to ship to peer t
\*                    (one queue per ordered pair, modelling cr-sqlite's
\*                    per-peer causal delivery)
\* opsCount         : total Insert+Tombstone ops issued (bounds state space)
\* usedIds          : itemIds already minted across the cluster
VARIABLES rows, channel, opsCount, usedIds

vars == << rows, channel, opsCount, usedIds >>

\* ---------------------------------------------------------------------------
\* Helpers
\* ---------------------------------------------------------------------------

\* Lookup a row by itemId within a peer's row set.
RowById(rs, id) == CHOOSE r \in rs : r.itemId = id

\* Does a row with this itemId exist?
HasId(rs, id) == \E r \in rs : r.itemId = id

\* Is this parent reference valid in the row set?
\* The root is always a valid parent; otherwise the parent row must exist.
ParentValid(rs, parentId, parentIx) ==
    \/ parentId = RootId
    \/ \E r \in rs : r.itemId = parentId /\ r.idx = parentIx

\* Append `entry` to the channel from `from` to every other peer at once.
\* This models a single local write being broadcast through cr-sqlite's
\* per-peer outboxes; each receiver will drain its channel in order.
BroadcastFrom(ch, from, entry) ==
    [ pair \in DOMAIN ch |->
        IF pair[1] = from /\ pair[2] /= from
        THEN Append(ch[pair], entry)
        ELSE ch[pair] ]

\* ---------------------------------------------------------------------------
\* Render is intentionally abstract.
\*
\* Strong Convergence only requires Render to be a deterministic function of
\* the row set. Real implementations differ in tie-breaking, but every
\* conforming implementation is a pure function of `rows`. For TLC we do not
\* need to fix an implementation; we only need TLC to see that two equal row
\* sets produce equal renders. Defining Render as a function from row sets
\* to sets of tuples gives us that property by construction.
\* ---------------------------------------------------------------------------

\* The set of rows that survive the tombstone filter and have a valid parent
\* in the row set. A row whose parent is missing is dropped, never surfaced
\* (NoOrphanReads).
VisibleRows(rs) ==
    { r \in rs :
        /\ r.tombstoned = 0
        /\ ParentValid(rs, r.parentItemId, r.parentIdx) }

\* Render reduces to a set of (content, itemId, idx) triples. Since this is
\* a pure function of `rs`, two peers with identical `rs` have identical
\* renders, satisfying StrongConvergence trivially.
Render(rs) ==
    { << r.content, r.itemId, r.idx >> : r \in VisibleRows(rs) }

\* ---------------------------------------------------------------------------
\* Initial state: every peer empty, every channel empty
\* ---------------------------------------------------------------------------
Init ==
    /\ rows     = [p \in Peers |-> {}]
    /\ channel  = [pair \in Peers \X Peers |-> << >>]
    /\ opsCount = 0
    /\ usedIds  = {}

\* ---------------------------------------------------------------------------
\* Action: Insert
\*
\* Peer `p` mints a new row whose parent is either RootId or some existing
\* row in p's local state. The row is added to p's rows AND broadcast through
\* all of p's outbound channels. Every column is set atomically in this one
\* action -- the heart of the Option 3 design.
\* ---------------------------------------------------------------------------
Insert(p) ==
    /\ opsCount < MaxOps
    /\ \E newId \in ItemIds \ usedIds,
          newIdx \in Idxs,
          c \in Content,
          parent \in {RootId} \cup { r.itemId : r \in rows[p] } :
        LET parentIdx ==
                IF parent = RootId
                THEN 0
                ELSE RowById(rows[p], parent).idx
            newRow ==
                [ itemId       |-> newId,
                  idx          |-> newIdx,
                  content      |-> c,
                  parentItemId |-> parent,
                  parentIdx    |-> parentIdx,
                  tombstoned   |-> 0 ]
        IN  /\ rows'     = [rows EXCEPT ![p] = @ \cup {newRow}]
            /\ channel'  = BroadcastFrom(channel, p, newRow)
            /\ usedIds'  = usedIds \cup {newId}
            /\ opsCount' = opsCount + 1

\* ---------------------------------------------------------------------------
\* Action: Tombstone
\*
\* Peer `p` flips an existing non-tombstoned row's tombstoned flag 0 -> 1.
\* This is the ONLY cell-level mutation permitted in the protocol. We ship
\* the updated row (with tombstoned=1) through every outbound channel; in
\* the real cr-sqlite system this corresponds to shipping just the
\* tombstoned cell, but at the model level it is equivalent because the
\* receiver merges by itemId and only ever takes the max of the tombstoned
\* flag (see ApplyOne).
\* ---------------------------------------------------------------------------
Tombstone(p) ==
    /\ opsCount < MaxOps
    /\ \E r \in rows[p] :
        /\ r.tombstoned = 0
        /\ LET r2 == [r EXCEPT !.tombstoned = 1]
           IN  /\ rows'     = [rows EXCEPT ![p] = (@ \ {r}) \cup {r2}]
               /\ channel'  = BroadcastFrom(channel, p, r2)
               /\ opsCount' = opsCount + 1
    /\ UNCHANGED usedIds

\* ---------------------------------------------------------------------------
\* Merge semantics for one incoming row (cr-sqlite ON CONFLICT under the
\* atomic-row assumption):
\*   - If `rs` does not already have a row with this itemId, insert it.
\*   - If `rs` already has the row, the only legal divergence is on
\*     tombstoned. Resolve by max(tombstoned): once tombstoned, always
\*     tombstoned (TombstoneMonotonicity).
\*   - All other fields are guaranteed to match by the atomic-row invariant
\*     because they were set exactly once at INSERT time.
\* ---------------------------------------------------------------------------
ApplyOne(rs, incoming) ==
    IF HasId(rs, incoming.itemId)
    THEN LET existing == RowById(rs, incoming.itemId)
             merged   == [existing EXCEPT
                            !.tombstoned =
                                IF existing.tombstoned = 1 \/ incoming.tombstoned = 1
                                THEN 1
                                ELSE 0]
         IN  (rs \ {existing}) \cup {merged}
    ELSE rs \cup {incoming}

\* ---------------------------------------------------------------------------
\* Action: Deliver
\*
\* Drain a single message from one channel into the receiver. This models
\* cr-sqlite delivering changes one row at a time, in source order per peer.
\* By delivering one row at a time we get every possible interleaving across
\* the (from, to) pairs while preserving per-channel FIFO -- the causality
\* property cr-sqlite gives us.
\* ---------------------------------------------------------------------------
Deliver(from, to) ==
    /\ from /= to
    /\ channel[<<from, to>>] /= << >>
    /\ LET incoming == Head(channel[<<from, to>>])
       IN  /\ rows'    = [rows EXCEPT ![to] = ApplyOne(@, incoming)]
           /\ channel' = [channel EXCEPT ![<<from, to>>] = Tail(@)]
    /\ UNCHANGED << opsCount, usedIds >>

\* ---------------------------------------------------------------------------
\* Next-state relation
\* ---------------------------------------------------------------------------
Next ==
    \/ \E p \in Peers : Insert(p)
    \/ \E p \in Peers : Tombstone(p)
    \/ \E from, to \in Peers : Deliver(from, to)

\* Weak fairness on Deliver gives liveness: if a delivery is continuously
\* enabled (channel non-empty) it eventually fires. This is the minimum
\* fairness needed for EventualConsistency given peers keep operating.
Fairness == \A from, to \in Peers : WF_vars(Deliver(from, to))

Spec == Init /\ [][Next]_vars /\ Fairness

\* ---------------------------------------------------------------------------
\* Type invariant
\* ---------------------------------------------------------------------------
TypeOK ==
    /\ rows     \in [Peers -> SUBSET Row]
    /\ channel  \in [Peers \X Peers -> Seq(Row)]
    /\ opsCount \in 0..MaxOps
    /\ usedIds  \subseteq ItemIds

\* ---------------------------------------------------------------------------
\* Safety: Atomicity
\*
\* For every itemId that appears on two peers, every non-tombstone column
\* must agree across those peers. This is what the atomic-row invariant
\* buys: the only legal divergence is on tombstoned. If any other column
\* could diverge, Render would observe inconsistent visible nodes and Strong
\* Convergence would fail.
\* ---------------------------------------------------------------------------
AtomicityInvariant ==
    \A p1, p2 \in Peers :
        \A r1 \in rows[p1] :
            \A r2 \in rows[p2] :
                r1.itemId = r2.itemId =>
                    /\ r1.idx          = r2.idx
                    /\ r1.content      = r2.content
                    /\ r1.parentItemId = r2.parentItemId
                    /\ r1.parentIdx    = r2.parentIdx

\* ---------------------------------------------------------------------------
\* Safety: Strong Convergence
\*
\* If two peers hold the same row set, they render the same document. This
\* is trivially true because Render is a pure function; checking it confirms
\* the model has not accidentally introduced peer-local state into Render.
\* ---------------------------------------------------------------------------
StrongConvergence ==
    \A p1, p2 \in Peers :
        rows[p1] = rows[p2] => Render(rows[p1]) = Render(rows[p2])

\* ---------------------------------------------------------------------------
\* Safety: No Orphan Reads
\*
\* Every row surfaced by Render has a valid parent in the row set. Render
\* enforces this through VisibleRows; the invariant double-checks that no
\* peer ever surfaces a row whose parent is missing.
\* ---------------------------------------------------------------------------
NoOrphanReads ==
    \A p \in Peers :
        \A r \in VisibleRows(rows[p]) :
            ParentValid(rows[p], r.parentItemId, r.parentIdx)

\* ---------------------------------------------------------------------------
\* Safety: Tombstone Monotonicity (temporal property)
\*
\* Once any peer p sees a row with itemId X tombstoned=1, p's later states
\* never show that itemId as tombstoned=0. ApplyOne enforces this by max-
\* merging tombstone. We state it temporally so TLC checks it across the
\* whole behaviour.
\* ---------------------------------------------------------------------------
TombstoneMonotonicityProp ==
    \A p \in Peers :
        \A id \in ItemIds :
            [] ( ( \E r \in rows[p] : r.itemId = id /\ r.tombstoned = 1 )
                 => [] ( \A r \in rows[p] :
                           r.itemId = id => r.tombstoned = 1 ) )

\* ---------------------------------------------------------------------------
\* Liveness: Eventual Consistency
\*
\* Two complementary forms:
\*
\*   QuiescentAgreement (state invariant): whenever all channels are empty,
\*   peers must already agree. This is the safety-style consequence: if
\*   nothing is in flight, there is no excuse for divergence.
\*
\*   EventualConsistency (temporal): once we stop issuing operations
\*   (opsCount has reached its cap), fair delivery forces convergence. We
\*   express this as a leads-to: OpsExhausted ~> AllAgree.
\* ---------------------------------------------------------------------------
AllQuiet ==
    \A pair \in Peers \X Peers : channel[pair] = << >>

AllAgree ==
    \A p1, p2 \in Peers : rows[p1] = rows[p2]

OpsExhausted == opsCount = MaxOps

\* "Whenever all channels are empty, peers agree" -- under fairness this is
\* not just safety but also a useful sanity check on the merge logic.
QuiescentAgreement == AllQuiet => AllAgree

\* The real liveness statement: once no more operations can be issued, the
\* fairness on Deliver drains every channel and peers converge.
EventualConsistency == OpsExhausted ~> AllAgree

=============================================================================
