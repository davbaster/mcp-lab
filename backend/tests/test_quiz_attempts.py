"""Submit and grade quiz attempts (#16): POST .../chapters/{chapter_id}/quiz/attempts."""

import json
import random
import uuid
from datetime import timedelta

import pytest

from app.content_routes import get_shuffle
from app.main import app
from tests.auth_support import BASE_URL, assert_error, new_client, register, rows
from tests.content_support import VISITOR_KINDS, committed_spec, put_progress, visitor_headers
from tests.course_support import FIXTURE_BUILD
from tests.quiz_support import (
    ATTEMPT_COURSES,
    CHAPTERS,
    EPSILON,
    SCORE_SETS,
    SECRET_MARKERS,
    answers,
    attempt_count,
    attempt_rows,
    attempt_url,
    correct_id,
    pass_chapter,
    progress_row,
    seed_attempt_row,
    state,
    submit,
    wrong_id,
)

NO_STORE = "private, no-store"
FAILED_KEYS = {"course_id", "chapter_id", "score", "total", "passed", "wrong"}
PASSED_KEYS = {
    "course_id",
    "chapter_id",
    "score",
    "total",
    "passed",
    "results",
    "next_chapter_id",
    "course_complete",
}
RESULT_KEYS = {
    "question_id",
    "option_id",
    "correct_option_id",
    "is_correct",
    "explanation",
    "lesson_id",
}
# The lesson each question of the fixture links to (question number -> lesson letter).
LESSON_LETTER = {1: "a", 2: "b", 3: "a", 4: "b", 5: "a"}
GAMMA = "/api/courses/gamma-course/chapters"
PROGRESS = f"/api/courses/{EPSILON}/progress"


def lesson_of(chapter_no, n):
    slug = "first" if chapter_no == 1 else "second"
    return f"{slug}-{LESSON_LETTER[n]}"


def headers_text(response):
    return "\n".join(f"{k}: {v}" for k, v in response.headers.items())


def assert_no_key(response):
    """No answer key and no option ID anywhere in a failed attempt's body or headers."""
    text = response.text + "\n" + headers_text(response)
    assert "SENTINEL" not in text
    for marker in SECRET_MARKERS:
        assert marker not in text


def progress_of(client):
    return {c["id"]: c for c in client.get(PROGRESS).json()["chapters"]}


# --- the request body ---


def test_the_five_answers_in_any_order_give_the_same_result(ana):
    body = answers(1, right=(1, 2, 4, 5))
    shuffled = list(body)
    random.Random(3).shuffle(shuffled)
    assert shuffled != body

    first = ana.post(attempt_url(), json={"answers": body})
    second = ana.post(attempt_url(), json={"answers": shuffled})
    third = ana.post(attempt_url(), json={"answers": list(reversed(body))})

    assert first.status_code == 200
    assert second.json() == first.json() == third.json()
    assert first.json()["score"] == 4


SHAPE_ERRORS = {
    "an array": [],
    "a string": "answers",
    "null": None,
    "an empty object": {},
    "no answers key": {"other": []},
    "answers null": {"answers": None},
    "answers a string": {"answers": "abc"},
    "answers an object": {"answers": {"01-first-1": "k3q7-1-1"}},
    "more than 50 items": {"answers": [{"question_id": "q", "option_id": "o"}] * 51},
    "an item that is a string": {"answers": ["01-first-1"]},
    "an item without question_id": {"answers": [{"option_id": "o"}]},
    "an item without option_id": {"answers": [{"question_id": "q"}]},
    "an empty question_id": {"answers": [{"question_id": "", "option_id": "o"}]},
    "an empty option_id": {"answers": [{"question_id": "q", "option_id": ""}]},
    "a number as question_id": {"answers": [{"question_id": 1, "option_id": "o"}]},
    "null as option_id": {"answers": [{"question_id": "q", "option_id": None}]},
    "a list as option_id": {"answers": [{"question_id": "q", "option_id": ["o"]}]},
    "a question_id of 101 characters": {"answers": [{"question_id": "q" * 101, "option_id": "o"}]},
    "an option_id of 101 characters": {"answers": [{"question_id": "q", "option_id": "o" * 101}]},
    "an extra key in the body": {"answers": answers(), "extra": 1},
    "an extra key in an item": {
        "answers": [{**a, "correct": True} if i == 0 else a for i, a in enumerate(answers())]
    },
}


@pytest.mark.parametrize("name", list(SHAPE_ERRORS))
def test_a_body_with_the_wrong_shape_is_422_and_saves_nothing(ana, db, name):
    before = state(db)

    response = ana.post(attempt_url(), json=SHAPE_ERRORS[name])

    assert_error(response, 422, "validation_error")
    assert state(db) == before


@pytest.mark.parametrize("content", [b"", b"{ not json", b"\xff\xfe", b"[" * 100000])
def test_a_body_that_is_not_json_is_422_and_saves_nothing(ana, db, content):
    before = state(db)

    response = ana.post(
        attempt_url(), content=content, headers={"content-type": "application/json"}
    )

    assert_error(response, 422, "validation_error")
    assert state(db) == before


def test_a_field_of_100_characters_passes_the_shape_check_and_fails_the_quiz_check(ana, db):
    body = {"answers": [{"question_id": "q" * 100, "option_id": "o" * 100}]}

    message = assert_error(ana.post(attempt_url(), json=body), 422, "validation_error")

    assert message == "answers[0]: this quiz has no such question."


def test_exactly_50_items_pass_the_shape_check(ana):
    body = {"answers": [{"question_id": "q", "option_id": "o"}] * 50}

    message = assert_error(ana.post(attempt_url(), json=body), 422, "validation_error")

    assert message == "answers[0]: this quiz has no such question."


def question(n, chapter_no=1):
    return f"{CHAPTERS[chapter_no]}-{n}"


def with_answer(n, option_id, base=None):
    """A body whose answer to question `n` is replaced."""
    items = list(base or answers())
    items[n - 1] = {"question_id": question(n), "option_id": option_id}
    return {"answers": items}


QUIZ_ERRORS = {
    "an unknown question": (
        lambda: {
            "answers": [
                *answers()[:2],
                {"question_id": "nope", "option_id": "k3q7-1-3"},
                *answers()[3:],
            ]
        },
        "answers[2]: this quiz has no such question.",
    ),
    "a question of the other chapter": (
        lambda: {
            "answers": [*answers()[:4], {"question_id": "02-second-5", "option_id": "k3q7-2-5"}]
        },
        "answers[4]: this quiz has no such question.",
    ),
    "a question answered twice": (
        lambda: {"answers": [*answers(), answers()[1]]},
        "Question 01-first-2 is answered more than once.",
    ),
    "a question answered twice with different options": (
        lambda: {"answers": [*answers(), {"question_id": "01-first-4", "option_id": "w9d2-1-4-y"}]},
        "Question 01-first-4 is answered more than once.",
    ),
    "a missing question": (
        lambda: {"answers": [a for a in answers() if a["question_id"] != "01-first-3"]},
        "Question 01-first-3 has no answer.",
    ),
    "the first question missing": (
        lambda: {"answers": answers()[1:]},
        "Question 01-first-1 has no answer.",
    ),
    "no answers at all": (lambda: {"answers": []}, "Question 01-first-1 has no answer."),
    "an option that exists nowhere": (
        lambda: with_answer(4, "NOT-AN-OPTION"),
        "Question 01-first-4: the chosen option is not one of its options.",
    ),
    "an option of another question": (
        lambda: with_answer(2, correct_id(1, 1)),
        "Question 01-first-2: the chosen option is not one of its options.",
    ),
    "an option of the other chapter": (
        lambda: with_answer(5, correct_id(2, 5)),
        "Question 01-first-5: the chosen option is not one of its options.",
    ),
}


@pytest.mark.parametrize("name", list(QUIZ_ERRORS))
def test_an_answer_that_does_not_fit_the_quiz_is_422_with_the_fixed_message_and_saves_nothing(
    ana, db, name
):
    build, expected = QUIZ_ERRORS[name]
    before = state(db)

    response = ana.post(attempt_url(), json=build())

    assert assert_error(response, 422, "validation_error") == expected
    assert state(db) == before
    assert_no_key(response)


def test_the_first_problem_wins_unknown_then_twice_then_missing_then_option(ana):
    unknown = {"answers": [{"question_id": "nope", "option_id": "x"}, answers()[0], answers()[0]]}
    twice = {"answers": [answers()[0], answers()[0], with_answer(2, "ZZZ")["answers"][1]]}
    missing = {"answers": [with_answer(1, "ZZZ")["answers"][0], answers()[1]]}

    assert assert_error(ana.post(attempt_url(), json=unknown), 422, "validation_error").startswith(
        "answers[0]:"
    )
    assert (
        assert_error(ana.post(attempt_url(), json=twice), 422, "validation_error")
        == "Question 01-first-1 is answered more than once."
    )
    assert (
        assert_error(ana.post(attempt_url(), json=missing), 422, "validation_error")
        == "Question 01-first-3 has no answer."
    )


def test_a_message_never_holds_the_clients_text_or_an_option_id(ana):
    body = {
        "answers": [
            *answers()[:4],
            {"question_id": "CLIENT-TEXT-QUESTION", "option_id": "CLIENT-TEXT-OPTION"},
        ]
    }
    unknown = ana.post(attempt_url(), json=body)
    bad_option = ana.post(attempt_url(), json=with_answer(3, "CLIENT-TEXT-OPTION"))

    for response in (unknown, bad_option):
        assert response.status_code == 422
        assert "CLIENT-TEXT" not in response.text
        assert "k3q7" not in response.text and "w9d2" not in response.text


# --- the shuffle cannot change a grade ---


def quiz_options(client, chapter="01-first"):
    return client.get(f"/api/courses/{EPSILON}/chapters/{chapter}/quiz").json()["questions"]


def pick_by_text(questions, right):
    """Answer by option text: the correct text for the questions in `right`, else the 'x' text."""
    picked = []
    for n, q in enumerate(questions, start=1):
        want = (
            f"CORRECT-SENTINEL-epsilon-1-{n}" if n in right else f"WRONG-SENTINEL-epsilon-1-{n}-x"
        )
        option = next(o for o in q["options"] if o["text"] == want)
        picked.append({"question_id": q["id"], "option_id": option["id"]})
    return {"answers": picked}


@pytest.fixture
def shuffles():
    """Run a block with a given deterministic shuffle."""

    def use(function):
        app.dependency_overrides[get_shuffle] = lambda: function

    yield use
    app.dependency_overrides.pop(get_shuffle, None)


@pytest.mark.parametrize("right", [(1, 2, 3), (1, 2, 3, 4, 5)])
def test_two_different_shuffles_of_the_same_choices_give_the_same_result(ana, shuffles, right):
    shuffles(lambda items: items.reverse())
    first_quiz = quiz_options(ana)
    first = ana.post(attempt_url(), json=pick_by_text(first_quiz, right))
    shuffles(lambda items: items.append(items.pop(0)))  # rotate
    second_quiz = quiz_options(ana)
    second = ana.post(attempt_url(), json=pick_by_text(second_quiz, right))

    assert [o["id"] for o in first_quiz[1]["options"]] != [
        o["id"] for o in second_quiz[1]["options"]
    ]
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert first.json()["score"] == len(right)


# --- access ---


BAD_BODY = {"answers": "not a list"}


@pytest.mark.parametrize("kind", VISITOR_KINDS)
def test_a_visitor_gets_401_for_every_course_and_chapter_even_with_an_invalid_body(
    ana, db, clock, kind
):
    headers = visitor_headers(kind, ana, clock)
    before = state(db)

    for url in (
        attempt_url("01-first"),
        attempt_url("02-second"),
        f"{GAMMA}/01-intro/quiz/attempts",
        f"{GAMMA}/03-end/quiz/attempts",  # free_preview
        attempt_url("99-nope"),
        attempt_url("01-first", course="nope"),
        attempt_url("UPPER"),
    ):
        for body in ({"answers": answers()}, BAD_BODY, [], {}):
            response = new_client().post(url, json=body, headers=headers)

            assert_error(response, 401, "not_authenticated")
            assert "SENTINEL" not in response.text
    not_json = new_client().post(
        attempt_url(), content=b"{ nope", headers={**headers, "content-type": "application/json"}
    )
    assert_error(not_json, 401, "not_authenticated")
    assert state(db) == before


def test_a_new_learner_may_not_take_a_locked_chapter_and_may_take_the_first(ana, db):
    before = state(db)

    locked = submit(ana, chapter_no=2)
    gamma_two = ana.post(f"{GAMMA}/02-middle/quiz/attempts", json={"answers": answers()})
    gamma_three = ana.post(
        f"{GAMMA}/03-end/quiz/attempts", json={"answers": answers()}
    )  # free_preview
    first = submit(ana)

    assert_error(locked, 403, "chapter_locked")
    assert_error(gamma_two, 403, "chapter_locked")
    assert_error(gamma_three, 403, "chapter_locked")
    for response in (locked, gamma_two, gamma_three):
        assert "SENTINEL" not in response.text
    assert first.status_code == 200
    assert attempt_count(db) == 1  # only the allowed one
    assert state(db)["attempts"] != before["attempts"]


def test_a_locked_chapter_does_not_read_the_quiz_file(serve, db, clock, build_copy):
    client = serve(ATTEMPT_COURSES, build=build_copy)
    client.base_url = BASE_URL
    assert register(client).status_code == 201
    (build_copy / "private" / "quizzes" / EPSILON / "02-second.json").unlink()  # after the start

    assert_error(submit(client, chapter_no=2), 403, "chapter_locked")


def test_the_check_is_require_quiz_access_called_as_it_is(ana, monkeypatch):
    import app.quiz_routes as routes

    calls = []

    def refuse(course, chapter, signed_in):
        calls.append((course.id, chapter.id))
        from app.errors import ApiError

        raise ApiError(403, "chapter_locked", "stub")

    monkeypatch.setattr(routes, "require_quiz_access", refuse)

    assert_error(submit(ana), 403, "chapter_locked")
    assert calls == [(EPSILON, "01-first")]


def test_a_passed_chapter_may_be_retaken_and_the_next_one_opens(ana):
    pass_chapter(ana)

    assert submit(ana).status_code == 200  # the passed chapter
    assert submit(ana, chapter_no=2).status_code == 200  # now in progress


def test_out_of_order_data_chapter_2_passed_chapter_1_not_allows_both(ana, db):
    put_progress(db, "ana1", "02-second", course=EPSILON, passed=True)

    assert submit(ana, chapter_no=2).status_code == 200
    assert submit(ana, chapter_no=1).status_code == 200


def test_a_quiz_with_one_question_is_a_server_fault_not_a_grade(server_errors, db):
    # gamma chapter 1 is in progress for a new learner, so the access check passes; its quiz
    # has one question, which the grader cannot use.
    response = server_errors.post(f"{GAMMA}/01-intro/quiz/attempts", json={"answers": answers()})

    assert_error(response, 500, "internal_error")
    assert attempt_count(db) == 0


def test_an_unknown_course_is_404_course_not_found(ana, db):
    response = ana.post(attempt_url("01-first", course="nope"), json={"answers": answers()})

    assert_error(response, 404, "course_not_found")
    assert attempt_count(db) == 0


@pytest.mark.parametrize(
    "chapter", ["99-nope", "UPPER", "%2e%2e", "..", "a" * 5000, "with space", "01_first"]
)
def test_an_unknown_or_odd_chapter_is_404_chapter_not_found(ana, db, chapter):
    response = ana.post(attempt_url(chapter), json={"answers": answers()})

    assert response.status_code == 404
    if response.json()["error"]["code"] != "not_found":  # a path the router itself cannot match
        assert_error(response, 404, "chapter_not_found")
    assert attempt_count(db) == 0


def test_the_body_shape_is_checked_before_the_course_and_the_chapter(ana):
    assert_error(ana.post(attempt_url(course="nope"), json={}), 422, "validation_error")
    assert_error(ana.post(attempt_url("99-nope"), json={}), 422, "validation_error")


def test_the_course_is_checked_before_the_chapter_and_the_chapter_before_access(ana):
    body = {"answers": answers()}

    assert_error(
        ana.post(attempt_url("99-nope", course="nope"), json=body), 404, "course_not_found"
    )
    assert_error(ana.post(attempt_url("99-nope"), json=body), 404, "chapter_not_found")
    assert_error(ana.post(attempt_url("02-second"), json={"answers": []}), 403, "chapter_locked")


# --- grading and the two responses ---


@pytest.mark.parametrize("score", range(6))
def test_the_score_is_the_number_of_correct_options_and_4_or_more_passes(ana, score):
    response = submit(ana, right=SCORE_SETS[score])

    assert response.status_code == 200
    body = response.json()
    assert (body["course_id"], body["chapter_id"]) == (EPSILON, "01-first")
    assert (body["score"], body["total"]) == (score, 5)
    assert body["passed"] is (score >= 4)


def test_the_response_has_cache_control_private_no_store_for_both_outcomes(ana):
    assert submit(ana, right=(1, 2, 3)).headers["cache-control"] == NO_STORE
    assert submit(ana).headers["cache-control"] == NO_STORE


@pytest.mark.parametrize("score", range(4))
def test_a_failed_attempt_has_exactly_the_failed_keys_and_the_wrong_questions_in_quiz_order(
    ana, score
):
    body = submit(ana, right=SCORE_SETS[score]).json()

    assert set(body) == FAILED_KEYS
    assert body["passed"] is False
    wrong = [n for n in range(1, 6) if n not in SCORE_SETS[score]]
    assert body["wrong"] == [
        {"question_id": question(n), "lesson_id": lesson_of(1, n)} for n in wrong
    ]
    for item in body["wrong"]:
        assert set(item) == {"question_id", "lesson_id"}


@pytest.mark.parametrize("score", [4, 5])
def test_a_passed_attempt_has_exactly_the_passed_keys_and_one_result_per_question(ana, score):
    right = SCORE_SETS[score]
    body = submit(ana, right=right).json()

    assert set(body) == PASSED_KEYS
    assert body["passed"] is True
    assert len(body["results"]) == 5
    for n, result in enumerate(body["results"], start=1):
        assert set(result) == RESULT_KEYS
        assert result == {
            "question_id": question(n),
            "option_id": correct_id(1, n) if n in right else wrong_id(1, n),
            "correct_option_id": correct_id(1, n),
            "is_correct": n in right,
            "explanation": f"EXPLANATION-SENTINEL-epsilon-1-{n}",
            "lesson_id": lesson_of(1, n),
        }
    assert [r["is_correct"] for r in body["results"]].count(False) == 5 - score


def test_a_4_of_5_pass_has_exactly_one_incorrect_result(ana):
    body = submit(ana, right=(1, 2, 3, 5), which={4: "y"}).json()

    wrong = [r for r in body["results"] if not r["is_correct"]]
    assert [r["question_id"] for r in wrong] == [question(4)]
    assert wrong[0]["option_id"] == wrong_id(1, 4, "y")  # the learner's own choice is echoed


@pytest.mark.parametrize("score", range(4))
@pytest.mark.parametrize("which", [{}, {2: "y", 4: "y"}])
def test_a_failed_attempt_never_leaks_the_key_or_the_learners_option_ids(ana, score, which):
    response = submit(ana, right=SCORE_SETS[score], which=which)

    assert response.status_code == 200 and response.json()["passed"] is False
    assert_no_key(response)
    # the check looks at the right body: the wrong questions and their lessons do appear
    wrong = [n for n in range(1, 6) if n not in SCORE_SETS[score]]
    for n in wrong:
        assert question(n) in response.text
        assert lesson_of(1, n) in response.text
    for n in SCORE_SETS[score]:
        assert question(n) not in response.text


def test_a_wrong_option_chosen_on_every_question_leaks_nothing(ana):
    response = submit(ana, right=(), which={2: "y", 4: "y"})

    assert response.json()["score"] == 0
    assert len(response.json()["wrong"]) == 5
    assert_no_key(response)


def test_two_failures_that_differ_only_in_the_wrong_option_have_byte_identical_bodies(ana):
    first = submit(ana, right=(1, 3, 5), which={2: "x", 4: "x"})
    second = submit(ana, right=(1, 3, 5), which={2: "y", 4: "y"})
    third = submit(ana, right=(1, 3, 5), which={2: "x", 4: "y"})

    assert first.status_code == 200
    assert first.content == second.content == third.content


def test_a_failed_retake_of_a_passed_chapter_has_the_failed_shape_and_leaks_nothing(ana):
    pass_chapter(ana)

    response = submit(ana, right=(1, 2), which={3: "x"})

    body = response.json()
    assert set(body) == FAILED_KEYS and body["passed"] is False
    assert_no_key(response)
    assert progress_of(ana)["01-first"]["status"] == "passed"


def test_after_a_failed_attempt_the_quiz_read_and_other_endpoints_still_hold_no_key(ana):
    submit(ana, right=(1, 2, 3))
    quiz = ana.get(f"/api/courses/{EPSILON}/chapters/01-first/quiz")
    others = [
        ana.get(PROGRESS),
        ana.get(f"/api/courses/{EPSILON}/chapters"),
        ana.get(f"/api/courses/{EPSILON}/lessons/first-a"),
        ana.get("/api/auth/me"),
    ]

    def keys(value):
        if isinstance(value, dict):
            for key, inner in value.items():
                yield key
                yield from keys(inner)
        elif isinstance(value, list):
            for inner in value:
                yield from keys(inner)

    assert quiz.status_code == 200
    assert not {"correct", "explanation", "lesson"} & set(keys(quiz.json()))
    assert "EXPLANATION-SENTINEL" not in quiz.text
    for response in others:
        assert response.status_code == 200
        assert "EXPLANATION-SENTINEL" not in response.text
        assert "CORRECT-SENTINEL" not in response.text


def test_a_failure_leaks_nothing_to_the_error_responses_either(ana):
    for response in (
        ana.post(attempt_url(), json=with_answer(2, "ZZZ")),
        ana.post(attempt_url("02-second"), json={"answers": answers(2)}),
        ana.post(attempt_url(), json={}),
    ):
        assert response.status_code in (403, 422)
        assert_no_key(response)


# --- saving ---


def test_every_graded_attempt_is_saved_with_its_answers_and_the_clock_time(ana, db, clock):
    submit(ana, right=(1, 2, 3), which={4: "y"})
    clock.advance(minutes=5)
    submit(ana)

    stored = rows(
        db,
        "SELECT id, account_id, course_id, chapter_id, score, passed, answers, created_at"
        " FROM app.quiz_attempts ORDER BY created_at",
    )
    account = rows(db, "SELECT id FROM app.accounts WHERE username = 'ana1'")[0][0]
    assert len(stored) == 2
    failed, passed = stored
    for row in stored:
        assert isinstance(row.id, uuid.UUID)
        assert row.account_id == account
        assert (row.course_id, row.chapter_id) == (EPSILON, "01-first")
    assert (failed.score, failed.passed) == (3, False)
    assert failed.answers == {
        question(1): correct_id(1, 1),
        question(2): correct_id(1, 2),
        question(3): correct_id(1, 3),
        question(4): wrong_id(1, 4, "y"),
        question(5): wrong_id(1, 5),
    }
    assert (passed.score, passed.passed) == (5, True)
    assert passed.answers == {question(n): correct_id(1, n) for n in range(1, 6)}
    assert failed.created_at == clock.now - timedelta(minutes=5)
    assert passed.created_at == clock.now
    assert failed.id != passed.id


@pytest.mark.parametrize(
    "send",
    [
        lambda c: c.post(attempt_url(), json={"answers": []}),
        lambda c: c.post(attempt_url(), json={}),
        lambda c: c.post(attempt_url("02-second"), json={"answers": answers(2)}),
        lambda c: c.post(attempt_url("99-nope"), json={"answers": answers()}),
        lambda c: c.post(attempt_url(course="nope"), json={"answers": answers()}),
        lambda c: new_client().post(attempt_url(), json={"answers": answers()}),
    ],
    ids=["422 quiz", "422 shape", "403", "404 chapter", "404 course", "401"],
)
def test_a_rejected_submission_saves_no_attempt_and_changes_no_progress(ana, db, send):
    seed_attempt_row(db, "ana1", "01-first", EPSILON, 2)
    before = state(db)

    response = send(ana)

    assert response.status_code in (401, 403, 404, 422)
    assert state(db) == before


@pytest.mark.parametrize(
    ("scores", "best"),
    [
        ([0], 0),
        ([3, 2], 3),
        ([3, 5], 5),
        ([5, 1], 5),
        ([2, 3, 1, 3, 0], 3),
    ],
)
def test_best_score_is_the_highest_and_never_goes_down(ana, db, scores, best):
    for score in scores:
        assert submit(ana, right=SCORE_SETS[score]).json()["score"] == score

    stored = progress_row(db)
    assert stored[0] == best
    assert attempt_count(db) == len(scores)


def test_a_first_attempt_scoring_0_stores_0_not_null(ana, db):
    submit(ana, right=())

    assert progress_row(db) == (0, None, None)
    assert progress_of(ana)["01-first"]["best_score"] == 0


def test_a_failed_attempt_sets_the_score_and_leaves_the_chapter_in_progress(ana, db):
    submit(ana, right=(1, 2, 3))

    best, passed_at, _ = progress_row(db)
    assert (best, passed_at) == (3, None)
    progress = progress_of(ana)
    assert (progress["01-first"]["status"], progress["01-first"]["best_score"]) == (
        "in_progress",
        3,
    )
    assert progress["02-second"]["status"] == "locked"


def test_the_first_pass_sets_passed_at_to_the_clock_and_a_later_pass_keeps_it(ana, db, clock):
    first_time = clock.now
    submit(ana)
    clock.advance(hours=3)
    submit(ana, right=(1, 2, 3, 4))

    best, passed_at, _ = progress_row(db)
    assert passed_at == first_time
    assert best == 5


def test_a_later_failure_keeps_the_pass_the_time_and_the_best_score(ana, db, clock):
    first_time = clock.now
    submit(ana, right=(1, 2, 3, 4))
    clock.advance(days=0.5)
    submit(ana, right=(1,))

    assert progress_row(db) == (4, first_time, None)
    assert progress_of(ana)["01-first"]["status"] == "passed"
    assert [row[2] for row in attempt_rows(db)] == [4, 1]


def test_a_row_created_by_the_last_lesson_save_takes_the_score_and_keeps_the_lesson(ana, db):
    assert (
        ana.put(
            f"/api/courses/{EPSILON}/progress/last-lesson", json={"lesson_id": "first-b"}
        ).status_code
        == 204
    )
    assert progress_row(db) == (None, None, "first-b")

    submit(ana, right=(1, 2))
    assert progress_row(db) == (2, None, "first-b")
    pass_chapter(ana)
    best, passed_at, last = progress_row(db)
    assert (best, last) == (5, "first-b") and passed_at is not None


def test_a_last_lesson_save_after_an_attempt_changes_neither_the_score_nor_the_pass(ana, db):
    pass_chapter(ana)
    before = progress_row(db)

    ana.put(f"/api/courses/{EPSILON}/progress/last-lesson", json={"lesson_id": "first-a"})

    after = progress_row(db)
    assert after[:2] == before[:2]
    assert after[2] == "first-a"


def test_an_attempt_never_changes_the_last_lesson(ana, db):
    ana.put(f"/api/courses/{EPSILON}/progress/last-lesson", json={"lesson_id": "first-a"})

    for right in ((1,), (1, 2, 3, 4, 5), (2,)):
        submit(ana, right=right)
        assert progress_row(db)[2] == "first-a"


def test_rows_are_per_learner_another_learners_rows_and_attempts_are_untouched(ana, db):
    bob = new_client()
    assert register(bob, "bob1").status_code == 201
    submit(bob, right=(1, 2))
    bob_progress = progress_row(db, username="bob1")
    bob_attempts = attempt_rows(db, "bob1")

    pass_chapter(ana)
    submit(ana, right=())

    assert progress_row(db, username="bob1") == bob_progress == (2, None, None)
    assert attempt_rows(db, "bob1") == bob_attempts
    assert progress_row(db)[0] == 5
    assert len(attempt_rows(db, "ana1")) == 2
    assert progress_of(bob)["01-first"]["best_score"] == 2


def test_a_row_of_another_course_with_the_same_chapter_id_is_untouched(ana, db):
    seed_attempt_row(db, "ana1", "01-first", "alpha-course", 1)
    put_progress(db, "ana1", "02-second", course="alpha-course", score=5, passed=True)
    alpha_before = rows(
        db,
        "SELECT chapter_id, best_score, passed_at FROM app.chapter_progress"
        " WHERE course_id = 'alpha-course' ORDER BY chapter_id",
    )

    pass_chapter(ana)

    alpha_after = rows(
        db,
        "SELECT chapter_id, best_score, passed_at FROM app.chapter_progress"
        " WHERE course_id = 'alpha-course' ORDER BY chapter_id",
    )
    assert alpha_after == alpha_before
    assert progress_row(db, "01-first", "alpha-course")[0] == 1
    assert {row[0] for row in attempt_rows(db)} == {EPSILON}


# --- progress effects ---


def test_after_a_pass_the_chapter_is_passed_and_the_next_chapter_opens(ana):
    assert_error(ana.get(f"/api/courses/{EPSILON}/chapters/02-second/quiz"), 403, "chapter_locked")

    pass_chapter(ana)

    progress = progress_of(ana)
    assert (progress["01-first"]["status"], progress["01-first"]["best_score"]) == ("passed", 5)
    assert progress["02-second"]["status"] == "in_progress"
    assert ana.get(f"/api/courses/{EPSILON}/chapters/02-second/quiz").status_code == 200


def test_after_a_failure_the_next_chapter_stays_locked(ana):
    submit(ana, right=(1, 2, 3))

    assert_error(ana.get(f"/api/courses/{EPSILON}/chapters/02-second/quiz"), 403, "chapter_locked")
    assert_error(submit(ana, chapter_no=2), 403, "chapter_locked")


def test_passing_a_chapter_that_is_not_the_last_names_the_next_and_is_not_complete(ana):
    body = pass_chapter(ana).json()

    assert (body["next_chapter_id"], body["course_complete"]) == ("02-second", False)
    assert ana.get(PROGRESS).json()["course_complete"] is False


def test_passing_the_last_remaining_chapter_completes_the_course(ana):
    pass_chapter(ana)
    body = pass_chapter(ana, chapter_no=2).json()

    assert (body["next_chapter_id"], body["course_complete"]) == (None, True)
    assert ana.get(PROGRESS).json()["course_complete"] is True


def test_a_retake_pass_of_a_complete_course_keeps_it_complete(ana):
    pass_chapter(ana)
    pass_chapter(ana, chapter_no=2)

    again = pass_chapter(ana, chapter_no=1).json()
    last_again = pass_chapter(ana, chapter_no=2).json()

    assert (again["next_chapter_id"], again["course_complete"]) == ("02-second", True)
    assert (last_again["next_chapter_id"], last_again["course_complete"]) == (None, True)
    assert ana.get(PROGRESS).json()["course_complete"] is True


def test_a_failed_retake_does_not_undo_a_complete_course(ana):
    pass_chapter(ana)
    pass_chapter(ana, chapter_no=2)

    submit(ana, right=(1,), chapter_no=2)

    assert ana.get(PROGRESS).json()["course_complete"] is True


def test_out_of_order_data_passing_chapter_1_later_completes_the_course(ana, db):
    put_progress(db, "ana1", "02-second", course=EPSILON, passed=True)

    body = pass_chapter(ana).json()

    assert (body["next_chapter_id"], body["course_complete"]) == ("02-second", True)


def test_a_new_learner_walks_to_a_complete_course_through_the_endpoints_only(ana):
    def statuses():
        return [c["status"] for c in ana.get(PROGRESS).json()["chapters"]]

    assert statuses() == ["in_progress", "locked"]
    assert quiz_options(ana)  # reading the quiz first, as the page does

    failed = submit(ana, right=(1, 3, 5)).json()
    assert failed["passed"] is False and failed["score"] == 3
    assert statuses() == ["in_progress", "locked"]

    passed = submit(ana, right=(1, 2, 3, 4)).json()
    assert passed["passed"] is True and passed["score"] == 4
    assert passed["next_chapter_id"] == "02-second" and passed["course_complete"] is False
    assert statuses() == ["passed", "in_progress"]

    assert quiz_options(ana, "02-second")
    failed_two = submit(ana, right=(2,), chapter_no=2).json()
    assert failed_two["passed"] is False
    assert statuses() == ["passed", "in_progress"]

    finish = submit(ana, chapter_no=2).json()
    assert finish["passed"] is True and finish["next_chapter_id"] is None
    assert finish["course_complete"] is True
    assert statuses() == ["passed", "passed"]
    progress = ana.get(PROGRESS).json()
    assert progress["course_complete"] is True
    assert [c["best_score"] for c in progress["chapters"]] == [4, 5]


# --- logs ---


def graded_lines(caplog):
    return [r.getMessage() for r in caplog.records if "Quiz attempt graded" in r.getMessage()]


def test_each_graded_attempt_writes_one_line_with_ids_score_and_outcome_and_no_secret(
    ana, db, caplog
):
    token = ana.cookies.get("session")
    account = str(rows(db, "SELECT id FROM app.accounts")[0][0])
    caplog.clear()

    failed = submit(ana, right=(1, 2, 3), which={4: "y"})
    passed = submit(ana, right=(1, 2, 3, 4))
    rejected = ana.post(attempt_url(), json=with_answer(2, "ZZZ-LOG-OPTION"))

    assert (failed.status_code, passed.status_code, rejected.status_code) == (200, 200, 422)
    assert graded_lines(caplog) == [
        "Quiz attempt graded: course_id=epsilon-course chapter_id=01-first score=3 total=5 outcome=failed",
        "Quiz attempt graded: course_id=epsilon-course chapter_id=01-first score=4 total=5 outcome=passed",
    ]
    logged = caplog.text + "\n".join(str(r.__dict__) for r in caplog.records)
    for secret in (
        token,
        f"session={token}",
        account,
        "ana1",
        "secret123",
        "ZZZ-LOG-OPTION",
        *SECRET_MARKERS,
        "SENTINEL",
    ):
        assert secret not in logged


def test_the_log_line_of_a_server_fault_holds_no_secret_and_no_attempt_line(
    serve, db, clock, build_copy, caplog
):
    path = build_copy / "private" / "quizzes" / EPSILON / "01-first.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    document["questions"][0]["explanation"] = {"x": "KEY-SENTINEL-1"}
    path.write_text(json.dumps(document), encoding="utf-8")
    client = serve(ATTEMPT_COURSES, build=build_copy)
    client.base_url = BASE_URL
    assert register(client).status_code == 201
    errors = new_client(raise_server_exceptions=False)
    errors.cookies.set("session", client.cookies.get("session"))
    caplog.clear()

    response = submit(errors)

    assert_error(response, 500, "internal_error")
    assert graded_lines(caplog) == []
    for secret in ("KEY-SENTINEL", "EXPLANATION-SENTINEL", "CORRECT-SENTINEL", "k3q7", "w9d2"):
        assert secret not in caplog.text + response.text


# --- a bad quiz file ---


QUIZ_FILE = f"private/quizzes/{EPSILON}/01-first.json"
BROKEN = {
    "an invalid field": lambda d: d["questions"][1].update(explanation={"x": "KEY-SENTINEL-1"}),
    "a missing correct": lambda d: d["questions"][1].pop("correct"),
    "4 questions": lambda d: d["questions"].pop(),
    "6 questions": lambda d: d["questions"].append({**d["questions"][0], "id": "01-first-6"}),
    "correct is not an option": lambda d: d["questions"][2].update(correct="KEY-SENTINEL-2"),
    "lesson is not of the chapter": lambda d: d["questions"][3].update(lesson="second-a"),
    "a repeated question id": lambda d: d["questions"][4].update(id="01-first-1"),
    "a repeated option id": lambda d: d["questions"][1]["options"][1].update(
        id=d["questions"][1]["options"][0]["id"]
    ),
    "a single option": lambda d: d["questions"][0].update(options=d["questions"][0]["options"][:1]),
    "the quiz of another chapter": lambda d: d.update(chapter_id="02-second"),
}


@pytest.fixture
def broken_quiz(serve, db, clock, build_copy, caplog):
    """A signed-in client (500s are responses) on a copy of the build that a test breaks."""
    client = serve(ATTEMPT_COURSES, build=build_copy)
    client.base_url = BASE_URL
    assert register(client).status_code == 201
    errors = new_client(raise_server_exceptions=False)
    errors.cookies.set("session", client.cookies.get("session"))
    errors.build = build_copy
    caplog.clear()
    return errors


def assert_server_fault(response, db, caplog, before):
    assert_error(response, 500, "internal_error")
    assert state(db) == before
    for secret in ("KEY-SENTINEL", "EXPLANATION-SENTINEL", "CORRECT-SENTINEL", "k3q7", "w9d2"):
        assert secret not in response.text
        assert secret not in caplog.text + "\n".join(str(r.__dict__) for r in caplog.records)


@pytest.mark.parametrize("name", list(BROKEN))
def test_a_quiz_file_the_grader_cannot_use_is_a_500_that_saves_nothing_and_leaks_nothing(
    broken_quiz, db, caplog, name
):
    path = broken_quiz.build / QUIZ_FILE
    document = json.loads(path.read_text(encoding="utf-8"))
    BROKEN[name](document)
    path.write_text(json.dumps(document), encoding="utf-8")
    before = state(db)

    response = submit(broken_quiz)

    assert_server_fault(response, db, caplog, before)


@pytest.mark.parametrize("content", [None, b"", b"{ KEY-SENTINEL", b'["KEY-SENTINEL"]'])
def test_a_missing_or_unreadable_quiz_file_is_a_500_that_saves_nothing(
    broken_quiz, db, caplog, content
):
    path = broken_quiz.build / QUIZ_FILE
    if content is None:
        path.unlink()
    else:
        path.write_bytes(content)
    before = state(db)

    assert_server_fault(submit(broken_quiz), db, caplog, before)


def test_the_quiz_file_is_read_again_by_the_next_request(broken_quiz, db):
    path = broken_quiz.build / QUIZ_FILE
    good = (FIXTURE_BUILD / QUIZ_FILE).read_text(encoding="utf-8")
    path.write_text("{", encoding="utf-8")
    assert_error(submit(broken_quiz), 500, "internal_error")

    path.write_text(good, encoding="utf-8")

    assert submit(broken_quiz).status_code == 200
    assert attempt_count(db) == 1


# --- atomicity ---


def test_when_the_progress_write_fails_the_attempt_is_not_saved_and_the_response_is_a_500(
    server_errors, db, monkeypatch, caplog
):
    import app.quiz_attempts as attempts

    def fail(*args, **kwargs):
        raise RuntimeError("the progress upsert failed")

    monkeypatch.setattr(attempts, "upsert_progress", fail)
    before = state(db)

    response = submit(server_errors)

    assert_error(response, 500, "internal_error")
    assert attempt_count(db) == 0
    assert state(db) == before
    assert graded_lines(caplog) == []
    assert_no_key(response)


def test_when_the_read_after_the_write_fails_nothing_is_saved_and_no_result_is_returned(
    server_errors, db, monkeypatch
):
    import app.quiz_routes as routes

    def fail(*args, **kwargs):  # the route's own read, which follows the two writes
        raise RuntimeError("the read failed")

    monkeypatch.setattr(routes, "load_progress", fail)

    response = submit(server_errors)

    assert_error(response, 500, "internal_error")
    assert response.json() == {
        "error": {"code": "internal_error", "message": "Internal server error."}
    }
    assert attempt_count(db) == 0
    assert progress_row(db) is None


def test_a_real_database_error_leaves_the_learners_answers_out_of_the_response_and_the_log(
    server_errors, db, monkeypatch, caplog
):
    """Postgres prints the failing row, `answers` included, in the error DETAIL.

    The route's `hide_database_details()` is what keeps that text out of the log. A plain
    exception (as the tests above inject) would not notice the wrapper missing, so this one
    breaks the row with a real CHECK violation: the route saves the attempt under a chapter ID
    that the table's format check refuses.
    """

    import app.quiz_routes as routes

    real = routes.record_attempt

    def record_under_a_bad_chapter_id(db_session, **kwargs):
        return real(db_session, **{**kwargs, "chapter_id": "BAD CHAPTER ID"})

    monkeypatch.setattr(routes, "record_attempt", record_under_a_bad_chapter_id)
    which = {2: "y", 4: "y"}
    learners_options = [a["option_id"] for a in answers(1, right=(1, 3), which=which)]
    assert "w9d2-1-2-y" in learners_options
    caplog.clear()

    response = submit(server_errors, right=(1, 3), which=which)

    assert_error(response, 500, "internal_error")
    assert response.json() == {
        "error": {"code": "internal_error", "message": "Internal server error."}
    }
    assert attempt_count(db) == 0
    assert progress_row(db) is None
    logged = caplog.text + "\n".join(str(r.__dict__) for r in caplog.records)
    assert "Database error (SQLSTATE" in logged  # the failure was logged, without its detail
    for secret in (*learners_options, "k3q7", "w9d2", "Failing row", "BAD CHAPTER ID", "SENTINEL"):
        assert secret not in logged
        assert secret not in response.text


def test_the_real_database_error_does_carry_the_row_so_the_wrapper_is_what_hides_it(db):
    """The control for the test above: without the wrapper the error text holds the answers."""
    import uuid

    from sqlalchemy import text
    from sqlalchemy.exc import DBAPIError

    from tests.test_accounts_db import add_account

    with pytest.raises(DBAPIError) as excinfo, db.begin() as conn:
        account = add_account(conn, "Ana1")
        conn.execute(
            text(
                "INSERT INTO app.quiz_attempts (id, account_id, course_id, chapter_id, score,"
                " passed, answers, created_at) VALUES (:id, :a, 'c', 'BAD CHAPTER ID', 1, false,"
                " CAST(:answers AS jsonb), now())"
            ),
            {"id": uuid.uuid4(), "a": account, "answers": json.dumps({"q": "ANSWER-SENTINEL-9z"})},
        )

    assert "ANSWER-SENTINEL-9z" in str(excinfo.value.orig)


def test_the_next_request_after_a_failed_one_works(server_errors, db, monkeypatch):
    import app.quiz_attempts as attempts

    real = attempts.upsert_progress
    monkeypatch.setattr(attempts, "upsert_progress", lambda *a, **k: 1 / 0)
    assert_error(submit(server_errors), 500, "internal_error")
    monkeypatch.setattr(attempts, "upsert_progress", real)

    assert submit(server_errors).status_code == 200
    assert attempt_count(db) == 1


# --- the contract ---


def operation():
    return committed_spec()["paths"][
        "/api/courses/{course_id}/chapters/{chapter_id}/quiz/attempts"
    ]["post"]


def test_the_endpoint_is_in_the_spec_with_the_cookie_required_and_the_error_shape():
    post = operation()

    assert post["operationId"] == "submitQuizAttempt"
    assert post["security"] == [{"SessionCookie": []}]
    assert [p["name"] for p in post["parameters"]] == ["course_id", "chapter_id"]
    assert all(p["in"] == "path" and p["required"] for p in post["parameters"])
    assert post["requestBody"]["required"] is True
    assert post["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/AttemptRequest"
    }
    for status in ("401", "403", "404", "422", "500"):
        assert post["responses"][status]["content"]["application/json"]["schema"] == {
            "$ref": "#/components/schemas/ErrorResponse"
        }
    assert set(post["responses"]) == {"200", "401", "403", "404", "422", "500"}
    assert "Cache-Control" in post["responses"]["200"]["headers"]


def test_the_200_is_the_union_of_the_two_shapes_told_apart_by_the_literal_passed():
    schemas = committed_spec()["components"]["schemas"]
    union = operation()["responses"]["200"]["content"]["application/json"]["schema"]

    assert union["anyOf"] == [
        {"$ref": "#/components/schemas/FailedAttemptResponse"},
        {"$ref": "#/components/schemas/PassedAttemptResponse"},
    ]
    assert "discriminator" not in union  # OpenAPI discriminator values must be strings
    assert schemas["FailedAttemptResponse"]["properties"]["passed"]["const"] is False
    assert schemas["PassedAttemptResponse"]["properties"]["passed"]["const"] is True


def test_the_failed_schema_has_no_property_that_could_hold_the_key():
    schemas = committed_spec()["components"]["schemas"]
    failed = schemas["FailedAttemptResponse"]
    wrong = schemas["WrongQuestion"]

    assert set(failed["properties"]) == FAILED_KEYS
    assert set(wrong["properties"]) == {"question_id", "lesson_id"}
    assert not {
        "correct_option_id",
        "explanation",
        "results",
        "next_chapter_id",
        "course_complete",
        "option_id",
    } & (set(failed["properties"]) | set(wrong["properties"]))
    assert failed["properties"]["passed"]["const"] is False
    assert failed["additionalProperties"] is False and wrong["additionalProperties"] is False


def test_the_passed_schema_lists_every_field_and_passed_is_true():
    schemas = committed_spec()["components"]["schemas"]
    passed = schemas["PassedAttemptResponse"]

    assert set(passed["properties"]) == PASSED_KEYS
    assert set(passed["required"]) == PASSED_KEYS
    assert passed["properties"]["passed"]["const"] is True
    assert set(schemas["QuestionResult"]["properties"]) == RESULT_KEYS
    assert passed["additionalProperties"] is False


def test_the_request_schema_forbids_extra_keys_and_bounds_the_lists_and_ids():
    schemas = committed_spec()["components"]["schemas"]
    request, item = schemas["AttemptRequest"], schemas["AnswerItem"]

    assert request["additionalProperties"] is False and item["additionalProperties"] is False
    assert request["properties"]["answers"]["maxItems"] == 50
    for field in ("question_id", "option_id"):
        assert (item["properties"][field]["minLength"], item["properties"][field]["maxLength"]) == (
            1,
            100,
        )


def test_the_response_models_forbid_extra_fields_and_type_passed_as_literals():
    from typing import Literal, get_args

    from app.quiz_routes import (
        AnswerItem,
        AttemptRequest,
        FailedAttemptResponse,
        PassedAttemptResponse,
        QuestionResult,
        WrongQuestion,
    )

    for model in (
        AttemptRequest,
        AnswerItem,
        FailedAttemptResponse,
        PassedAttemptResponse,
        QuestionResult,
        WrongQuestion,
    ):
        assert model.model_config["extra"] == "forbid"
    assert FailedAttemptResponse.model_fields["passed"].annotation == Literal[False]
    assert PassedAttemptResponse.model_fields["passed"].annotation == Literal[True]
    assert get_args(Literal[False]) == (False,)
