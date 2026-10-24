"""Read a chapter's quiz with its answer key, for grading only.

`app.content.read_quiz` leaves the key out on purpose, so the quiz `GET` cannot leak it. This
module is the one reader that keeps it: for each question the option IDs, the `correct` ID, the
`explanation`, and the `lesson` link. It is used by the attempt route (#16) and nowhere else.
Nothing is cached: the key exists in memory only for the request that grades.

A file that is missing, invalid, or not a quiz the grader can use raises `BuildFileError` (a
server fault: 500, location only, never any content of the file, because the content is the key).
The grader can use a quiz that has exactly `QUESTIONS_PER_QUIZ` questions with distinct IDs, each
with at least two distinct option IDs, a `correct` that is one of them, and a `lesson` that is a
lesson of this chapter.
"""

from pydantic import BaseModel, ConfigDict, StrictStr

from app.content import BuildFileError, check_ids, read_json, validate_model
from app.courses import Catalog, Chapter, Course

QUESTIONS_PER_QUIZ = 5
PASS_SCORE = 4  # 4 of 5 (80%) passes


class KeyOption(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: StrictStr


class KeyQuestion(BaseModel):
    """A question with its answer key. Never send one of these to a client."""

    model_config = ConfigDict(extra="ignore")

    id: StrictStr
    options: list[KeyOption]
    correct: StrictStr
    explanation: StrictStr
    lesson: StrictStr


class _KeyFile(BaseModel):
    model_config = ConfigDict(extra="ignore")

    course_id: StrictStr
    chapter_id: StrictStr
    questions: list[KeyQuestion]


def _check_key(what: str, questions: list[KeyQuestion], chapter: Chapter) -> None:
    """Every rule below names a position or a fixed fact, never a value from the file."""
    if len(questions) != QUESTIONS_PER_QUIZ:
        raise BuildFileError(f"{what}: the quiz must have {QUESTIONS_PER_QUIZ} questions.")
    lessons = {lesson.id for lesson in chapter.lessons}
    seen: set[str] = set()
    for position, question in enumerate(questions, start=1):
        where = f"{what}: question {position}"
        if question.id in seen:
            raise BuildFileError(f"{where} repeats the ID of an earlier question.")
        seen.add(question.id)
        option_ids = [option.id for option in question.options]
        if len(option_ids) < 2:
            raise BuildFileError(f"{where} has fewer than 2 options.")
        if len(set(option_ids)) != len(option_ids):
            raise BuildFileError(f"{where} repeats an option ID.")
        if question.correct not in option_ids:
            raise BuildFileError(f"{where}: field correct is not one of its options.")
        if question.lesson not in lessons:
            raise BuildFileError(f"{where}: field lesson is not a lesson of this chapter.")


def read_quiz_key(catalog: Catalog, course: Course, chapter: Chapter) -> list[KeyQuestion]:
    """The questions of a chapter's quiz with their key, in file order."""
    what = f"Quiz file (course {course.id}, chapter {chapter.id})"
    path = catalog.build_dir / "private" / "quizzes" / course.id / f"{chapter.id}.json"
    document = validate_model(_KeyFile, read_json(path, what), what)
    check_ids(
        what,
        course_id=(document.course_id, course.id),
        chapter_id=(document.chapter_id, chapter.id),
    )
    _check_key(what, document.questions, chapter)
    return document.questions
