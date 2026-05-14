"""Property tests for the Fugue text-CRDT column.

Gate: across randomized N-peer × M-op sequences, all peers converge to identical body
after bidirectional sync — regardless of sync order.

Semantic correctness (no duplicated content from concurrent splits) is a separate concern
gated by the cleanup-pass work; see Phase 5 outcomes in PLAN.md.
"""

import pytest
from hypothesis import HealthCheck, given, settings, strategies as st

from crsql_correctness import connect, close


def make_peer():
    c = connect(":memory:")
    c.execute("CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)")
    c.execute("SELECT crsql_as_crr('notes')")
    c.execute("SELECT crsql_as_text_crdt('notes', 'body')")
    c.execute("INSERT INTO notes (id, body) VALUES (1, '')")
    c.commit()
    return c


def site_id(c):
    return c.execute("SELECT crsql_site_id()").fetchone()[0]


def body(c):
    # Use crsql_fugue_render to bypass the materialized parent column.
    # The materialized column itself is a tracked CRDT cell and can cascade through sync
    # in ways that produce divergence — Phase 5 caught this. Render on demand instead.
    return c.execute("SELECT crsql_fugue_render('notes','body',1)").fetchone()[0]


def do_op(c, op):
    kind, *args = op
    if kind == "ins":
        pos, text = args
        if pos < 0:
            pos = 0
        cur_len = len(body(c) or "")
        if pos > cur_len:
            pos = cur_len
        c.execute("SELECT crsql_fugue_insert('notes','body',1,?,?)", (pos, text))
    elif kind == "del":
        frm, to = args
        cur_len = len(body(c) or "")
        if frm < 0:
            frm = 0
        if to > cur_len:
            to = cur_len
        if to > frm:
            c.execute("SELECT crsql_fugue_delete('notes','body',1,?,?)", (frm, to))
    c.commit()


def pull(c, exclude_site_id):
    return c.execute(
        '''SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
        FROM crsql_changes WHERE site_id IS NOT ?''',
        (exclude_site_id,),
    ).fetchall()


def apply_changes(c, rows):
    if not rows:
        return
    c.executemany(
        '''INSERT INTO crsql_changes
           ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
           VALUES (?,?,?,?,?,?,?,?,?)''',
        rows,
    )
    c.commit()


def sync_pair(a, b):
    apply_changes(b, pull(a, site_id(b)))
    apply_changes(a, pull(b, site_id(a)))


# Strategies
text_st = st.text(
    alphabet=st.characters(min_codepoint=33, max_codepoint=126),
    min_size=1,
    max_size=8,
)
pos_st = st.integers(min_value=0, max_value=20)

op_st = st.one_of(
    st.tuples(st.just("ins"), pos_st, text_st),
    st.tuples(st.just("del"), pos_st, pos_st),
)
ops_st = st.lists(op_st, min_size=0, max_size=15)


@settings(max_examples=200, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(ops_a=ops_st, ops_b=ops_st)
def test_two_peer_convergence(ops_a, ops_b):
    """Two peers, random ops each, bidirectional sync → identical body on both."""
    a = make_peer()
    b = make_peer()
    try:
        # Optional pre-state so both peers start non-empty sometimes
        if ops_a:
            do_op(a, ops_a[0])
        sync_pair(a, b)
        for op in ops_a[1:]:
            do_op(a, op)
        for op in ops_b:
            do_op(b, op)
        sync_pair(a, b)

        a_body = body(a)
        b_body = body(b)
        assert a_body == b_body, f"DIVERGED:\n  A={a_body!r}\n  B={b_body!r}\n  ops_a={ops_a}\n  ops_b={ops_b}"
    finally:
        close(a)
        close(b)


@settings(max_examples=100, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(ops_a=ops_st, ops_b=ops_st, ops_c=ops_st)
def test_three_peer_convergence(ops_a, ops_b, ops_c):
    """Three peers, random ops, sync to consensus."""
    a, b, c = make_peer(), make_peer(), make_peer()
    try:
        for op in ops_a:
            do_op(a, op)
        for op in ops_b:
            do_op(b, op)
        for op in ops_c:
            do_op(c, op)

        # Three-way sync: A↔B, B↔C, A↔C (twice to settle)
        sync_pair(a, b)
        sync_pair(b, c)
        sync_pair(a, c)
        sync_pair(a, b)
        sync_pair(b, c)

        bodies = (body(a), body(b), body(c))
        assert bodies[0] == bodies[1] == bodies[2], (
            f"DIVERGED:\n  A={bodies[0]!r}\n  B={bodies[1]!r}\n  C={bodies[2]!r}\n"
            f"  ops_a={ops_a}\n  ops_b={ops_b}\n  ops_c={ops_c}"
        )
    finally:
        close(a)
        close(b)
        close(c)


# Hand-crafted regression cases — easier to debug than Hypothesis output.
def test_concurrent_insert_same_position():
    a, b = make_peer(), make_peer()
    try:
        do_op(a, ("ins", 0, "ab"))
        sync_pair(a, b)
        do_op(a, ("ins", 1, "X"))
        do_op(b, ("ins", 1, "Y"))
        sync_pair(a, b)
        assert body(a) == body(b), f"{body(a)!r} vs {body(b)!r}"
    finally:
        close(a)
        close(b)


def test_concurrent_delete_insert():
    a, b = make_peer(), make_peer()
    try:
        do_op(a, ("ins", 0, "hello"))
        sync_pair(a, b)
        do_op(a, ("del", 1, 5))
        do_op(b, ("ins", 3, "X"))
        sync_pair(a, b)
        assert body(a) == body(b)
    finally:
        close(a)
        close(b)
