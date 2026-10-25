"""Feedback sent at the same time (#24).

Threads wait at a barrier and then post together, each with its own client and the same session.
The final state is the same for every order the requests may run in, so nothing sleeps.
"""

from tests.feedback_support import body, feedback_count, feedback_rows, message, run_together, send

LIMIT_CODE = "feedback_limit_reached"


def post(n):
    return lambda client: send(client, body(message=message(n)))


def test_15_different_messages_at_once_store_exactly_10_and_refuse_5(ana_fb, db):
    token = ana_fb.cookies.get("session")

    responses = run_together(token, [post(n) for n in range(1, 16)])

    statuses = sorted(r.status_code for r in responses)
    assert statuses == [202] * 10 + [429] * 5
    assert {r.json()["error"]["code"] for r in responses if r.status_code == 429} == {LIMIT_CODE}
    assert feedback_count(db) == 10
    # The 10 stored are 10 distinct messages among the 15 sent.
    stored = {row["message"] for row in feedback_rows(db)}
    assert len(stored) == 10 and stored <= {message(n) for n in range(1, 16)}


def test_5_identical_messages_at_once_store_exactly_1_and_all_return_202(ana_fb, db):
    token = ana_fb.cookies.get("session")

    responses = run_together(token, [post(1)] * 5)

    assert [r.status_code for r in responses] == [202] * 5
    assert {r.content for r in responses} == {b""}
    assert feedback_count(db) == 1


def test_two_messages_racing_for_the_last_place_store_one_of_them_once(ana_fb, db, clock):
    for n in range(1, 10):
        assert send(ana_fb, body(message=message(n))).status_code == 202
    token = ana_fb.cookies.get("session")

    responses = run_together(token, [post(10)] * 4 + [post(11)] * 4)

    # One of the two messages takes the tenth place: its four copies get 202 (one stored, three
    # ignored). The four copies of the other message are over the limit.
    assert sorted(r.status_code for r in responses) == [202] * 4 + [429] * 4
    assert feedback_count(db) == 10


def test_two_learners_at_once_do_not_block_each_others_counts(fb_api, db):
    from tests.auth_support import register

    assert register(fb_api, "ana1").status_code == 201
    ana_token = fb_api.cookies.get("session")
    fb_api.cookies.clear()
    assert register(fb_api, "ben1").status_code == 201
    ben_token = fb_api.cookies.get("session")

    ana = run_together(ana_token, [post(n) for n in range(1, 13)])
    ben = run_together(ben_token, [post(n) for n in range(1, 13)])

    assert sorted(r.status_code for r in ana) == [202] * 10 + [429] * 2
    assert sorted(r.status_code for r in ben) == [202] * 10 + [429] * 2
    assert len(feedback_rows(db, "ana1")) == 10
    assert len(feedback_rows(db, "ben1")) == 10
