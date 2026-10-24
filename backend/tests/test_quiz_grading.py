"""Grading and the key reader of the quiz attempt (#16), with no database and no request."""

import json
import random
from pathlib import Path

import pytest

from app.content import BuildFileError
from app.courses import Catalog, load_catalog
from app.quiz_grading import AnswerError, grade, match_answers
from app.quiz_key import PASS_SCORE, QUESTIONS_PER_QUIZ, KeyOption, KeyQuestion, read_quiz_key
from tests.course_support import FIXTURE_BUILD

QUIZ_FILE = Path("private/quizzes/epsilon-course/01-first.json")


def make_questions():
    """Five questions with option IDs that repeat across questions, as old fixtures do."""
    return [
        KeyQuestion(
            id=f"q{n}",
            options=[KeyOption(id="a"), KeyOption(id="b"), KeyOption(id="c")],
            correct="abc"[n % 3],
            explanation=f"EXPLANATION-SENTINEL-{n}",
            lesson=f"lesson-{n % 2}",
        )
        for n in range(1, 6)
    ]


def choose(questions, right):
    """The matched answers: the correct option for the questions in `right`, else a wrong one."""
    chosen = {}
    for position, question in enumerate(questions):
        if position in right:
            chosen[question.id] = question.correct
        else:
            chosen[question.id] = next(o.id for o in question.options if o.id != question.correct)
    return chosen


def pairs(chosen):
    return list(chosen.items())


# --- the constants ---


def test_a_quiz_has_5_questions_and_4_pass():
    assert (QUESTIONS_PER_QUIZ, PASS_SCORE) == (5, 4)


# --- grading ---


@pytest.mark.parametrize("correct", range(6))
def test_the_score_is_the_number_of_correct_options_and_4_or_more_passes(correct):
    questions = make_questions()
    result = grade(questions, choose(questions, set(range(correct))))

    assert (result.score, result.total) == (correct, 5)
    assert result.passed is (correct >= 4)
    assert len(result.wrong) == 5 - correct


def test_3_of_5_fails_and_4_of_5_passes():
    questions = make_questions()

    assert grade(questions, choose(questions, {0, 1, 2})).passed is False
    assert grade(questions, choose(questions, {0, 1, 2, 3})).passed is True


def test_results_are_in_quiz_order_with_the_key_of_each_question():
    questions = make_questions()
    result = grade(questions, choose(questions, {0, 2, 3, 4}))

    assert [r.question_id for r in result.results] == [q.id for q in questions]
    assert [r.is_correct for r in result.results] == [True, False, True, True, True]
    assert [r.correct_option_id for r in result.results] == [q.correct for q in questions]
    assert [r.lesson_id for r in result.results] == [q.lesson for q in questions]
    assert [r.explanation for r in result.results] == [q.explanation for q in questions]
    assert [w.question_id for w in result.wrong] == ["q2"]


def test_the_order_of_the_answers_does_not_change_the_grade():
    questions = make_questions()
    chosen = choose(questions, {0, 1, 2, 4})
    shuffled = pairs(chosen)
    random.Random(7).shuffle(shuffled)

    assert grade(questions, match_answers(questions, shuffled)) == grade(
        questions, match_answers(questions, pairs(chosen))
    )


def test_the_same_option_id_in_every_question_is_judged_per_question():
    questions = make_questions()  # `a`, `b`, `c` are options of every question
    wrong_everywhere = {q.id: "abc"[(("abc".index(q.correct)) + 1) % 3] for q in questions}

    result = grade(questions, match_answers(questions, pairs(wrong_everywhere)))

    assert result.score == 0


# --- matching the answers to the quiz, and the order of the errors ---


def error_of(questions, answers):
    with pytest.raises(AnswerError) as excinfo:
        match_answers(questions, answers)
    return str(excinfo.value)


def test_a_complete_submission_matches():
    questions = make_questions()
    chosen = choose(questions, {0})

    assert match_answers(questions, pairs(chosen)) == chosen


def test_an_unknown_question_names_the_index_and_never_the_clients_text():
    questions = make_questions()
    answers = pairs(choose(questions, set()))
    answers[3] = ("EVIL-question-id", "a")

    message = error_of(questions, answers)

    assert message == "answers[3]: this quiz has no such question."
    assert "EVIL" not in message


def test_a_question_answered_twice_names_the_question_id():
    questions = make_questions()
    answers = pairs(choose(questions, set())) + [("q2", "b")]

    assert error_of(questions, answers) == "Question q2 is answered more than once."


def test_a_question_not_answered_names_the_first_one_in_quiz_order():
    questions = make_questions()
    answers = [a for a in pairs(choose(questions, set())) if a[0] not in ("q3", "q5")]

    assert error_of(questions, answers) == "Question q3 has no answer."


def test_no_answers_at_all_names_the_first_question():
    assert error_of(make_questions(), []) == "Question q1 has no answer."


def test_an_option_that_is_not_the_questions_own_names_the_question_and_never_the_option():
    questions = make_questions()
    answers = pairs(choose(questions, set()))
    answers[1] = ("q2", "OPTION-FROM-NOWHERE")

    message = error_of(questions, answers)

    assert message == "Question q2: the chosen option is not one of its options."
    assert "OPTION-FROM-NOWHERE" not in message


def test_an_option_of_another_question_is_rejected_for_the_question_where_it_does_not_exist():
    questions = make_questions()
    questions[1] = questions[1].model_copy(
        update={"options": [KeyOption(id="a"), KeyOption(id="z")]}
    )
    answers = pairs(choose(questions, set()))
    answers[1] = ("q2", "c")  # `c` exists in the other questions, not in this one

    assert (
        error_of(questions, answers) == "Question q2: the chosen option is not one of its options."
    )


def test_the_errors_come_in_the_order_unknown_duplicate_missing_option():
    questions = make_questions()
    base = pairs(choose(questions, set()))
    everything_wrong = [("nope", "a"), *base[:1], *base[:1], ("q2", "ZZZ")]

    assert error_of(questions, everything_wrong).startswith("answers[0]:")
    duplicate_and_missing = [*base[:1], *base[:1], ("q2", "ZZZ")]
    assert error_of(questions, duplicate_and_missing) == "Question q1 is answered more than once."
    missing_and_bad_option = [("q1", "ZZZ"), ("q2", "a")]
    assert error_of(questions, missing_and_bad_option) == "Question q3 has no answer."


# --- the key reader ---


@pytest.fixture
def catalog():
    return load_catalog("epsilon-course", str(FIXTURE_BUILD))


def read(catalog, chapter_no=0):
    course = catalog.get("epsilon-course")
    return read_quiz_key(catalog, course, course.chapters[chapter_no])


def test_the_reader_returns_the_five_questions_with_their_key_in_file_order(catalog):
    questions = read(catalog)
    document = json.loads((FIXTURE_BUILD / QUIZ_FILE).read_text(encoding="utf-8"))

    assert [q.id for q in questions] == [q["id"] for q in document["questions"]]
    assert [q.correct for q in questions] == [q["correct"] for q in document["questions"]]
    assert [q.explanation for q in questions] == [q["explanation"] for q in document["questions"]]
    assert [q.lesson for q in questions] == [q["lesson"] for q in document["questions"]]
    assert [len(q.options) for q in questions] == [2, 3, 2, 3, 2]


@pytest.fixture
def broken_catalog(tmp_path, catalog):
    import shutil

    build = tmp_path / "build"
    shutil.copytree(FIXTURE_BUILD, build)
    return Catalog(catalog.courses, build)


def edit_quiz(catalog, change):
    path = catalog.build_dir / QUIZ_FILE
    document = json.loads(path.read_text(encoding="utf-8"))
    change(document)
    path.write_text(json.dumps(document), encoding="utf-8")


CORRUPT = {
    "4 questions": lambda d: d["questions"].pop(),
    "6 questions": lambda d: d["questions"].append({**d["questions"][0], "id": "01-first-6"}),
    "no questions": lambda d: d.update(questions=[]),
    "a repeated question ID": lambda d: d["questions"][3].update(id=d["questions"][1]["id"]),
    "1 option": lambda d: d["questions"][0].update(options=d["questions"][0]["options"][:1]),
    "a repeated option ID": lambda d: d["questions"][1]["options"][2].update(
        id=d["questions"][1]["options"][0]["id"]
    ),
    "correct not an option": lambda d: d["questions"][2].update(correct="KEY-SENTINEL-nope"),
    "lesson of another chapter": lambda d: d["questions"][4].update(lesson="second-a"),
    "lesson unknown": lambda d: d["questions"][4].update(lesson="KEY-SENTINEL-lesson"),
    "no explanation": lambda d: d["questions"][0].pop("explanation"),
    "explanation not a string": lambda d: d["questions"][0].update(
        explanation={"x": "KEY-SENTINEL-1"}
    ),
    "no correct": lambda d: d["questions"][0].pop("correct"),
    "no lesson": lambda d: d["questions"][0].pop("lesson"),
    "wrong course_id": lambda d: d.update(course_id="alpha-course"),
    "wrong chapter_id": lambda d: d.update(chapter_id="02-second"),
}


@pytest.mark.parametrize("name", list(CORRUPT))
def test_a_quiz_the_grader_cannot_use_raises_a_build_file_error_with_a_location_only(
    broken_catalog, name
):
    edit_quiz(broken_catalog, CORRUPT[name])

    with pytest.raises(BuildFileError) as excinfo:
        read(broken_catalog)

    message = str(excinfo.value)
    assert "epsilon-course" in message and "01-first" in message
    for secret in ("SENTINEL", "k3q7", "w9d2"):
        assert secret not in message
    assert excinfo.value.__cause__ is None


@pytest.mark.parametrize("content", [b"", b"{ KEY-SENTINEL", b"\xff\xfe", b'["KEY-SENTINEL"]'])
def test_a_quiz_file_that_is_not_a_json_object_raises_without_its_content(broken_catalog, content):
    (broken_catalog.build_dir / QUIZ_FILE).write_bytes(content)

    with pytest.raises(BuildFileError) as excinfo:
        read(broken_catalog)

    assert "KEY-SENTINEL" not in str(excinfo.value)


def test_a_missing_quiz_file_raises(broken_catalog):
    (broken_catalog.build_dir / QUIZ_FILE).unlink()

    with pytest.raises(BuildFileError):
        read(broken_catalog)


def test_a_field_the_grader_does_not_know_is_ignored(broken_catalog):
    edit_quiz(broken_catalog, lambda d: d["questions"][0].update(hint="HINT-SENTINEL"))

    assert len(read(broken_catalog)) == 5


def test_the_reader_caches_nothing(broken_catalog):
    assert read(broken_catalog)[0].correct == "k3q7-1-1"
    edit_quiz(broken_catalog, lambda d: d["questions"][0].update(correct="w9d2-1-1-x"))

    assert read(broken_catalog)[0].correct == "w9d2-1-1-x"
