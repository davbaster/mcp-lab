"""The quiz read endpoint (#15): GET /api/courses/{course_id}/chapters/{chapter_id}/quiz."""

import json
import random

import pytest

from app.content_routes import get_shuffle
from app.main import app
from tests.auth_support import assert_error, new_client, register
from tests.content_support import (
    VISITOR_KINDS,
    committed_spec,
    put_progress,
    snapshot,
    visitor_headers,
)
from tests.course_support import FIXTURE_BUILD

DELTA = "/api/courses/delta-course/chapters"
GAMMA = "/api/courses/gamma-course/chapters"
QUIZ = f"{DELTA}/02-closed/quiz"
NO_STORE = "private, no-store"
TOP_KEYS = {"course_id", "chapter_id", "questions"}
QUESTION_KEYS = {"id", "text", "snippet", "options"}
OPTION_KEYS = {"id", "text"}
SNIPPET_KEYS = {"language", "code"}
ANSWER_KEYS = ("correct", "explanation", "lesson")
LINK = "quiz-link-7f3a"


def quiz_file(course="delta-course", chapter="02-closed", build=FIXTURE_BUILD):
    path = build / "private" / "quizzes" / course / f"{chapter}.json"
    return json.loads(path.read_text(encoding="utf-8"))


def keys_everywhere(value):
    """Every object key at any depth of a decoded JSON value."""
    if isinstance(value, dict):
        for key, inner in value.items():
            yield key
            yield from keys_everywhere(inner)
    elif isinstance(value, list):
        for inner in value:
            yield from keys_everywhere(inner)


def answer_sentinels(document):
    """The strings of a quiz file that no response may hold: the explanations and the links.

    The text of the correct option is not one of them: it is one of the options the learner
    chooses from, so it must appear. What must not appear is a second place that names it (see
    `assert_correct_text_only_as_an_option`).
    """
    return [value for q in document["questions"] for value in (q["explanation"], q["lesson"])]


def assert_correct_text_only_as_an_option(response, document):
    """The correct option's text occurs once per question, as an option text, and nowhere else."""
    body = response.json()
    for got, want in zip(body["questions"], document["questions"], strict=True):
        correct = next(o for o in want["options"] if o["id"] == want["correct"])
        assert response.text.count(correct["text"]) == 1
        assert [o["text"] for o in got["options"]].count(correct["text"]) == 1


@pytest.fixture
def delta_learner(learner, db):
    """`ana1` with delta chapter 1 passed, so chapter 2 (the five-question quiz) is open."""
    put_progress(db, "ana1", "01-open", course="delta-course", passed=True)
    return learner


@pytest.fixture
def reverse_options():
    app.dependency_overrides[get_shuffle] = lambda: lambda items: items.reverse()
    yield
    app.dependency_overrides.pop(get_shuffle, None)


# --- the shape ---


def test_the_quiz_has_exactly_the_documented_keys_at_every_level(delta_learner):
    response = delta_learner.get(QUIZ)

    assert response.status_code == 200
    body = response.json()
    assert set(body) == TOP_KEYS
    assert body["course_id"] == "delta-course"
    assert body["chapter_id"] == "02-closed"
    assert len(body["questions"]) == 5
    for question in body["questions"]:
        assert set(question) == QUESTION_KEYS
        assert question["snippet"] is None or set(question["snippet"]) == SNIPPET_KEYS
        for option in question["options"]:
            assert set(option) == OPTION_KEYS


def test_only_question_3_has_a_snippet_and_the_others_have_null(delta_learner):
    questions = delta_learner.get(QUIZ).json()["questions"]

    assert [q["snippet"] is not None for q in questions] == [False, False, True, False, False]
    assert questions[2]["snippet"] == {
        "language": "python",
        "code": "print('SNIPPET-SENTINEL-delta-3')\n",
    }
    assert all("snippet" in q for q in questions)  # the key is always present


def test_the_questions_are_in_file_order_with_the_texts_of_the_file(delta_learner):
    body = delta_learner.get(QUIZ).json()
    document = quiz_file()

    assert [q["id"] for q in body["questions"]] == [q["id"] for q in document["questions"]]
    assert [q["text"] for q in body["questions"]] == [q["text"] for q in document["questions"]]
    assert [len(q["options"]) for q in body["questions"]] == [2, 3, 2, 3, 2]


def test_option_ids_are_the_ids_of_the_file_and_no_option_is_lost_or_added(delta_learner):
    document = quiz_file()

    for _ in range(5):
        body = delta_learner.get(QUIZ).json()
        for got, want in zip(body["questions"], document["questions"], strict=True):
            assert sorted(o["id"] for o in got["options"]) == sorted(
                o["id"] for o in want["options"]
            )
            texts = {o["id"]: o["text"] for o in want["options"]}
            assert {o["id"]: o["text"] for o in got["options"]} == texts


def test_the_response_has_cache_control_private_no_store(delta_learner):
    assert delta_learner.get(QUIZ).headers["cache-control"] == NO_STORE


# --- no answer key ---


def test_no_answer_key_explanation_or_lesson_link_reaches_the_response(delta_learner):
    response = delta_learner.get(QUIZ)
    document = quiz_file()

    assert response.status_code == 200
    for key in keys_everywhere(response.json()):
        assert key not in ANSWER_KEYS
    for secret in answer_sentinels(document):
        assert secret not in response.text
    assert LINK not in response.text
    assert "EXPLANATION-SENTINEL" not in response.text
    assert_correct_text_only_as_an_option(response, document)


def test_the_check_finds_what_it_looks_for_wrong_options_and_questions_do_appear(delta_learner):
    text = delta_learner.get(QUIZ).text

    for n in range(1, 6):
        assert f"QUESTION-SENTINEL-delta-{n}" in text
    assert "WRONG-SENTINEL-delta-1-b" in text
    assert "WRONG-SENTINEL-delta-2-a" in text
    assert "SNIPPET-SENTINEL-delta-3" in text


def test_a_learner_who_passed_the_chapter_sees_the_same_shape_and_no_answers(delta_learner, db):
    put_progress(db, "ana1", "02-closed", course="delta-course", score=5, passed=True)
    response = delta_learner.get(QUIZ)

    assert response.status_code == 200
    assert set(response.json()) == TOP_KEYS
    for question in response.json()["questions"]:
        assert set(question) == QUESTION_KEYS
    for secret in answer_sentinels(quiz_file()):
        assert secret not in response.text
    assert_correct_text_only_as_an_option(response, quiz_file())


def test_a_key_added_to_a_question_in_the_file_does_not_reach_the_response(
    serve, db, clock, build_copy
):
    path = build_copy / "private" / "quizzes" / "delta-course" / "02-closed.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    for question in document["questions"]:
        question["hint"] = "HINT-SENTINEL"
        question["options"][0]["score"] = "SCORE-SENTINEL"
        question["options"][0]["is_correct"] = True
    document["secret"] = "TOP-SENTINEL"
    path.write_text(json.dumps(document), encoding="utf-8")
    client = serve("delta-course", build=build_copy)
    client.base_url = "https://testserver"
    assert register(client).status_code == 201
    put_progress(db, "ana1", "01-open", course="delta-course", passed=True)

    response = client.get(QUIZ)

    assert response.status_code == 200
    for sentinel in ("HINT-SENTINEL", "SCORE-SENTINEL", "TOP-SENTINEL", "hint", "is_correct"):
        assert sentinel not in response.text


def test_the_response_models_forbid_extra_fields_and_declare_no_answer_field():
    from app.content_routes import QuizOption, QuizQuestion, QuizResponse, QuizSnippet

    for model in (QuizResponse, QuizQuestion, QuizOption, QuizSnippet):
        assert model.model_config["extra"] == "forbid"
        assert not set(model.model_fields) & set(ANSWER_KEYS)


def test_no_schema_added_by_this_task_has_a_correct_explanation_or_lesson_property():
    schemas = committed_spec()["components"]["schemas"]

    for name in ("QuizResponse", "QuizQuestion", "QuizOption", "QuizSnippet"):
        assert name in schemas
        assert not set(schemas[name]["properties"]) & set(ANSWER_KEYS)
    for name in ("LessonResponse", "LastLessonRequest"):
        assert not set(schemas[name]["properties"]) & {"correct", "explanation"}


# --- the shuffle ---


def test_the_options_of_every_question_are_shuffled_with_the_injected_function(
    delta_learner, reverse_options
):
    body = delta_learner.get(QUIZ).json()

    for got, want in zip(body["questions"], quiz_file()["questions"], strict=True):
        assert [o["id"] for o in got["options"]] == [o["id"] for o in reversed(want["options"])]


def test_the_question_order_never_changes_with_the_shuffle(delta_learner, reverse_options):
    body = delta_learner.get(QUIZ).json()

    assert [q["id"] for q in body["questions"]] == [f"02-closed-{n}" for n in range(1, 6)]


def test_the_real_shuffle_gives_more_than_one_order_for_a_three_option_question(delta_learner):
    orders = {
        tuple(o["id"] for o in delta_learner.get(QUIZ).json()["questions"][1]["options"])
        for _ in range(30)
    }

    assert len(orders) > 1


def test_the_default_shuffle_is_a_method_of_a_system_random_instance():
    shuffle = get_shuffle()

    assert isinstance(shuffle.__self__, random.SystemRandom)
    assert shuffle.__self__ is not random._inst  # not the module-level generator


# --- access ---


@pytest.mark.parametrize("kind", VISITOR_KINDS)
def test_a_visitor_gets_401_for_every_chapter_free_preview_or_not_and_for_unknown_ones(
    content_api, clock, kind
):
    assert register(content_api).status_code == 201
    headers = visitor_headers(kind, content_api, clock)

    for url in (
        f"{GAMMA}/01-intro/quiz",  # free_preview
        f"{GAMMA}/02-middle/quiz",
        f"{GAMMA}/03-end/quiz",  # free_preview
        f"{DELTA}/01-open/quiz",
        f"{DELTA}/02-closed/quiz",
        f"{GAMMA}/99-nope/quiz",
        "/api/courses/nope/chapters/01-intro/quiz",
        f"{GAMMA}/UPPER/quiz",
    ):
        response = new_client().get(url, headers=headers)

        assert_error(response, 401, "not_authenticated")
        assert "SENTINEL" not in response.text


PASSES = {
    "a new learner": ([], (200, 403, 403)),
    "after chapter 1": (["01-intro"], (200, 200, 403)),
    "chapter 2 only (out of order)": (["02-middle"], (200, 200, 403)),
    "after chapters 1 and 2": (["01-intro", "02-middle"], (200, 200, 200)),
    "all chapters": (["01-intro", "02-middle", "03-end"], (200, 200, 200)),
}


@pytest.mark.parametrize("who", list(PASSES))
def test_the_quiz_access_matrix_of_a_learner_on_gamma_course(learner, db, who):
    passes, expected = PASSES[who]
    for chapter in passes:
        put_progress(db, "ana1", chapter, passed=True)

    got = tuple(
        learner.get(f"{GAMMA}/{chapter}/quiz").status_code
        for chapter in ("01-intro", "02-middle", "03-end")
    )

    assert got == expected


def test_a_locked_free_preview_chapter_is_still_locked_for_its_quiz(learner):
    # gamma chapter 3 is `free_preview` and `locked`: its lesson opens, its quiz does not.
    assert learner.get("/api/courses/gamma-course/lessons/end-lesson").status_code == 200

    response = learner.get(f"{GAMMA}/03-end/quiz")

    assert_error(response, 403, "chapter_locked")
    assert "SENTINEL" not in response.text


def test_a_learner_on_a_locked_chapter_gets_no_quiz_text(learner):
    response = learner.get(f"{GAMMA}/02-middle/quiz")

    assert_error(response, 403, "chapter_locked")
    assert "SENTINEL" not in response.text


def test_an_unknown_course_is_404_course_not_found_for_a_learner(learner):
    response = learner.get("/api/courses/nope/chapters/01-intro/quiz")

    assert_error(response, 404, "course_not_found")


@pytest.mark.parametrize(
    "chapter", ["99-nope", "UPPER", "%2e%2e", "a" * 5000, "with space", "01_intro"]
)
def test_an_unknown_or_odd_chapter_is_404_chapter_not_found_for_a_learner(learner, chapter):
    response = learner.get(f"{GAMMA}/{chapter}/quiz")

    assert_error(response, 404, "chapter_not_found")
    assert "SENTINEL" not in response.text


def test_a_chapter_of_another_course_is_404_chapter_not_found(learner):
    assert_error(learner.get(f"{GAMMA}/01-open/quiz"), 404, "chapter_not_found")
    assert_error(learner.get(f"{DELTA}/01-intro/quiz"), 404, "chapter_not_found")


def test_a_quiz_read_writes_nothing(delta_learner, db):
    before = snapshot(db)

    assert delta_learner.get(QUIZ).status_code == 200
    assert delta_learner.get(f"{DELTA}/01-open/quiz").status_code == 200

    assert snapshot(db) == before


def test_the_other_fixture_courses_return_the_one_question_their_file_holds(learner):
    body = learner.get(f"{GAMMA}/01-intro/quiz").json()

    assert [q["id"] for q in body["questions"]] == ["01-intro-1"]
    assert body["course_id"] == "gamma-course"


def test_the_operation_needs_the_cookie_and_declares_the_header():
    operation = committed_spec()["paths"]["/api/courses/{course_id}/chapters/{chapter_id}/quiz"][
        "get"
    ]

    assert operation["operationId"] == "getQuiz"
    assert operation["security"] == [{"SessionCookie": []}]
    assert operation["responses"]["200"]["headers"]["Cache-Control"]
