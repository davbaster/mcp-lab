"""Attempts that arrive at the same time (#16).

The tests start threads that a barrier releases together, each with its own client, and assert
the final state, which is the same for every order the requests may run in. Nothing sleeps. One
`serve()` call starts the app; the other clients are plain `TestClient`s on the same app.
"""

import threading
from concurrent.futures import ThreadPoolExecutor

from tests.auth_support import new_client
from tests.quiz_support import (
    EPSILON,
    SCORE_SETS,
    attempt_count,
    attempt_rows,
    progress_row,
    submit,
)

LAST_LESSON = f"/api/courses/{EPSILON}/progress/last-lesson"


def run_together(ana, jobs):
    """Run each job (a function of a client) in its own thread, released at the same moment.

    Returns the jobs' results in order. A job that raises makes the test fail.
    """
    barrier = threading.Barrier(len(jobs))
    token = ana.cookies.get("session")

    def work(job):
        client = new_client()
        client.cookies.set("session", token)
        barrier.wait()
        return job(client)

    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = [pool.submit(work, job) for job in jobs]
        return [future.result(timeout=60) for future in futures]


def attempt(score):
    return lambda client: submit(client, right=SCORE_SETS[score])


def test_attempts_of_different_scores_at_once_leave_the_highest_score_and_one_row_each(
    ana, db, clock
):
    scores = [0, 1, 2, 3, 4, 5]

    responses = run_together(ana, [attempt(score) for score in scores])

    assert [r.status_code for r in responses] == [200] * 6
    assert [r.json()["score"] for r in responses] == scores
    assert attempt_count(db) == 6
    assert sorted(row[2] for row in attempt_rows(db)) == scores
    best, passed_at, _ = progress_row(db)
    assert (best, passed_at) == (5, clock.now)


def test_attempts_that_all_fail_at_once_set_no_pass_and_keep_the_highest_score(ana, db):
    responses = run_together(ana, [attempt(score) for score in (3, 0, 2, 1, 3, 2)])

    assert {r.status_code for r in responses} == {200}
    assert attempt_count(db) == 6
    assert progress_row(db) == (3, None, None)


def test_two_passes_at_once_set_passed_at_once_and_save_two_attempts(ana, db, clock):
    responses = run_together(ana, [attempt(4), attempt(5)])

    assert [r.status_code for r in responses] == [200, 200]
    assert all(r.json()["passed"] for r in responses)
    assert attempt_count(db) == 2
    assert progress_row(db) == (5, clock.now, None)


def test_the_same_answers_submitted_twice_at_once_are_two_attempts_and_one_progress_row(ana, db):
    responses = run_together(ana, [attempt(3), attempt(3)])

    assert [r.status_code for r in responses] == [200, 200]
    assert responses[0].json() == responses[1].json()
    assert attempt_count(db) == 2
    assert progress_row(db) == (3, None, None)


def test_a_first_attempt_race_never_gives_a_duplicate_key_error(ana, db):
    responses = run_together(ana, [attempt(score) for score in (1, 2, 3, 2, 1, 0)])

    assert {r.status_code for r in responses} == {200}
    assert attempt_count(db) == 6
    assert progress_row(db)[0] == 3


def test_attempts_and_last_lesson_saves_at_once_keep_both_the_score_and_the_lesson(ana, db):
    def save(lesson):
        return lambda client: client.put(LAST_LESSON, json={"lesson_id": lesson})

    responses = run_together(
        ana,
        [attempt(1), save("first-b"), attempt(3), save("first-b"), attempt(2), save("first-b")],
    )

    assert [r.status_code for r in responses] == [200, 204, 200, 204, 200, 204]
    assert attempt_count(db) == 3
    assert progress_row(db) == (3, None, "first-b")


def test_a_pass_and_last_lesson_saves_at_once_keep_the_pass_and_the_lesson(ana, db, clock):
    def save(client):
        return client.put(LAST_LESSON, json={"lesson_id": "first-a"})

    responses = run_together(ana, [attempt(4), save, save, attempt(0)])

    assert [r.status_code for r in responses] == [200, 204, 204, 200]
    assert progress_row(db) == (4, clock.now, "first-a")
    assert attempt_count(db) == 2
