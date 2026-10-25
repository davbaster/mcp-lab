"""Fixtures and helpers shared by the feedback tests (#24).

The tests serve `alpha-course` and `beta-course`; `unlisted-course` is a fixture course that
`COURSES` does not name, so feedback for it is refused like feedback for any unknown course.
"""

import copy
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import text

from tests.auth_support import BASE_URL, login, new_client, register

FEEDBACK_URL = "/api/feedback"
FEEDBACK_COURSES = "alpha-course,beta-course"
REMOVE = object()  # as an override: leave this key out of the body

DEFAULT_CONTEXT = {
    "page_path": "/courses/alpha-course/lessons/first-a",
    "course_id": "alpha-course",
    "chapter_id": "01-first",
    "lesson_id": "first-a",
    "question_id": None,
    "app_version": "dev",
    "user_agent": "Mozilla/5.0 (X11; Linux x86_64) Test",
    "viewport": {"width": 1280, "height": 720},
    "client_time": "2030-01-15T12:00:00.123Z",
    "console_errors": [],
}
FEEDBACK_COLUMNS = (
    "course_id, chapter_id, lesson_id, question_id, category, message, about_quiz_question,"
    " page_path, app_version, user_agent, viewport_width, viewport_height, client_time,"
    " console_errors, status, created_at"
)


def message(n: int = 1) -> str:
    return f"Feedback message number {n:03d}"


def body(ctx: dict | None = None, **top) -> dict:
    """A valid request body. `ctx` changes keys of the context; a value of REMOVE drops the key."""
    result = {
        "category": "bug",
        "message": message(),
        "about_quiz_question": False,
        "context": copy.deepcopy(DEFAULT_CONTEXT),
    }
    result.update(top)
    for key, value in (ctx or {}).items():
        result["context"][key] = value
    for container in (result, result["context"]):
        for key in [k for k, v in container.items() if v is REMOVE]:
            del container[key]
    return result


def send(client, payload=REMOVE, **kwargs):
    """Post `payload` as JSON (a valid body when it is left out; `None` sends JSON null)."""
    return client.post(FEEDBACK_URL, json=body() if payload is REMOVE else payload, **kwargs)


def feedback_rows(db, username: str | None = None) -> list:
    """The rows (as mappings), oldest first, for one learner or for everyone."""
    where, params = "", {}
    if username is not None:
        where, params = (
            "WHERE account_id = (SELECT id FROM app.accounts WHERE username = :u)",
            {"u": username},
        )
    with db.connect() as conn:
        return list(
            conn.execute(
                text(
                    f"SELECT {FEEDBACK_COLUMNS} FROM app.feedback {where} ORDER BY created_at, id"
                ),
                params,
            ).mappings()
        )


def feedback_count(db) -> int:
    with db.connect() as conn:
        return conn.execute(text("SELECT count(*) FROM app.feedback")).scalar_one()


def sign_in_again(client, clock, username="ana1"):
    """A new session at the clock's current time (the old one lasts one day)."""
    client.cookies.clear()
    assert login(client, username).status_code == 200


def run_together(token, jobs):
    """Run each job (a function of a client signed in with `token`) in its own thread, all
    released at the same moment by a barrier. Returns the results in order."""
    barrier = threading.Barrier(len(jobs))

    def work(job):
        client = new_client()
        client.cookies.set("session", token)
        barrier.wait()
        return job(client)

    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = [pool.submit(work, job) for job in jobs]
        return [future.result(timeout=60) for future in futures]


@pytest.fixture
def fb_api(serve, db, clock):
    """The app serving alpha and beta, with a client that keeps its cookies."""
    client = serve(FEEDBACK_COURSES)
    client.base_url = BASE_URL
    return client


@pytest.fixture
def ana_fb(fb_api):
    """The client, signed in as `ana1`."""
    assert register(fb_api).status_code == 201
    return fb_api


@pytest.fixture
def fb_errors(ana_fb):
    """A client with `ana1`'s session that turns a server fault into a 500 response."""
    client = new_client(raise_server_exceptions=False)
    client.cookies.set("session", ana_fb.cookies.get("session"))
    return client
