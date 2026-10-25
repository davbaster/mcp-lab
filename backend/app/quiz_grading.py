"""Check a submission against a quiz and grade it. Pure: no database, no files, no clock.

Grading compares option IDs only, never positions, so the shuffle of the quiz `GET` cannot change
a score. If the quiz `GET` later serves other option IDs (#108), `grade` is the one place that
maps them back.

`AnswerError` messages are fixed text. They name a real question ID of this quiz or an index in
the client's list, never the client's own strings and never an option ID.
"""

from collections.abc import Sequence
from dataclasses import dataclass

from app.quiz_key import PASS_SCORE, KeyQuestion


class AnswerError(Exception):
    """The submission does not match the quiz. The message is safe to send to the client."""


@dataclass(frozen=True)
class QuestionResult:
    question_id: str
    option_id: str  # the learner's
    correct_option_id: str
    is_correct: bool
    explanation: str
    lesson_id: str


@dataclass(frozen=True)
class Grade:
    score: int
    total: int
    passed: bool
    results: tuple[QuestionResult, ...]  # in quiz order; the route decides who may see them

    @property
    def wrong(self) -> list[QuestionResult]:
        return [result for result in self.results if not result.is_correct]


def match_answers(
    questions: Sequence[KeyQuestion], answers: Sequence[tuple[str, str]]
) -> dict[str, str]:
    """The chosen option of every question, by question ID, or raise `AnswerError`.

    `answers` is a list of (question ID, option ID). The first problem found is reported, in this
    order: an unknown question, a question answered twice, a question not answered, an option that
    is not one of its own question's options.
    """
    by_id = {question.id: question for question in questions}
    chosen: dict[str, str] = {}
    for index, (question_id, _) in enumerate(answers):
        if question_id not in by_id:
            raise AnswerError(f"answers[{index}]: this quiz has no such question.")
    for question_id, option_id in answers:
        if question_id in chosen:
            raise AnswerError(f"Question {question_id} is answered more than once.")
        chosen[question_id] = option_id
    for question in questions:
        if question.id not in chosen:
            raise AnswerError(f"Question {question.id} has no answer.")
    for question in questions:
        if chosen[question.id] not in {option.id for option in question.options}:
            raise AnswerError(
                f"Question {question.id}: the chosen option is not one of its options."
            )
    return chosen


def grade(questions: Sequence[KeyQuestion], chosen: dict[str, str]) -> Grade:
    """Grade matched answers (see `match_answers`): one point per correct option ID."""
    results = tuple(
        QuestionResult(
            question_id=question.id,
            option_id=chosen[question.id],
            correct_option_id=question.correct,
            is_correct=chosen[question.id] == question.correct,
            explanation=question.explanation,
            lesson_id=question.lesson,
        )
        for question in questions
    )
    score = sum(result.is_correct for result in results)
    return Grade(score=score, total=len(results), passed=score >= PASS_SCORE, results=results)
