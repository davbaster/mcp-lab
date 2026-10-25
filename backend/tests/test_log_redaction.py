"""The redaction filter on the JSON handler (#36): keys, nested values, and text forms."""

import json
import logging

import pytest

from app.log_redaction import REDACTED, is_sensitive_key, redact_text, redact_value
from tests.obs_support import capture_logs, lines_of

# One sentinel for each kind of secret; the key name is the word the filter looks for.
SENTINELS = {
    "password": "PW-SENTINEL-1a",
    "token": "TOKEN-SENTINEL-2b",
    "session": "SESSION-SENTINEL-3c",
    "cookie": "COOKIE-SENTINEL-4d",
    "authorization": "AUTHZ-SENTINEL-5e",
    "answers": "ANSWERS-SENTINEL-6f",
    "option_id": "OPTION-SENTINEL-7g",
    "correct": "CORRECT-SENTINEL-8h",
    "explanation": "EXPL-SENTINEL-9i",
}
KINDS = list(SENTINELS)
logger = logging.getLogger("redaction.test")


def write(message="line", *args, level=logging.INFO, **extra):
    """Log one record through the production handler; return its parsed line and the raw text."""
    with capture_logs() as stream:
        logger.log(level, message, *args, extra=extra or None)
    (line,) = lines_of(stream)
    return line, stream.getvalue()


def assert_clean(raw: str, *secrets: str) -> None:
    for secret in secrets:
        assert secret not in raw
    assert REDACTED in raw
    assert len(raw.splitlines()) == 1
    json.loads(raw)


# --- keys ---


@pytest.mark.parametrize("kind", KINDS)
def test_a_top_level_field_with_a_sensitive_name_is_masked(kind):
    line, raw = write(**{kind: SENTINELS[kind]})

    assert line[kind] == REDACTED
    assert_clean(raw, SENTINELS[kind])


@pytest.mark.parametrize("kind", KINDS)
def test_a_value_three_levels_deep_and_in_a_list_of_dicts_is_masked(kind):
    secret = SENTINELS[kind]
    deep = {"a": {"b": {"c": {kind: secret, "keep": "visible"}}}}
    listed = [{"n": 1}, {"n": 2, kind: [secret, {"x": secret}]}]

    line, raw = write(deep=deep, listed=listed)

    assert line["deep"]["a"]["b"]["c"] == {kind: REDACTED, "keep": "visible"}
    assert line["listed"][0] == {"n": 1}
    assert line["listed"][1] == {"n": 2, kind: REDACTED}
    assert_clean(raw, secret)


@pytest.mark.parametrize(
    "key",
    ["PASSWORD", "Password", "Set-Cookie", "set-cookie", "X-Auth-Token", "x_auth_token",
     "Authorization", "Proxy-Authorization", "session_id", "sessionToken", "OPTION-ID", "Option_Id",
     "new_password", "answers", "is_correct", "correct_option_id", "explanation"],
)  # fmt: skip
def test_key_names_match_in_any_case_and_with_hyphens(key):
    assert is_sensitive_key(key)
    line, raw = write(payload={key: "SECRET-VALUE-1"})

    assert line["payload"] == {key: REDACTED}
    assert "SECRET-VALUE-1" not in raw


def test_a_key_that_is_not_sensitive_is_kept():
    for key in ("course_id", "chapter_id", "score", "total", "outcome", "category", "scope",
                "request_id", "route", "status", "latency_ms", "method", "message_count"):  # fmt: skip
        assert not is_sensitive_key(key)
    assert not is_sensitive_key(5)


def test_the_fields_the_app_writes_itself_are_never_masked():
    fields = {
        "course_id": "alpha-course",
        "chapter_id": "01-first",
        "score": 4,
        "total": 5,
        "outcome": "passed",
        "category": "bug",
        "scope": "ip",
        "request_id": "abc-123",
        "route": "/api/courses/{course_id}/lessons/{lesson_id}",
        "status": 200,
        "latency_ms": 1.5,
    }

    line, raw = write("Quiz attempt graded", **fields)

    for key, value in fields.items():
        assert line[key] == value
    assert REDACTED not in raw


def test_a_name_such_as_session_count_is_masked_on_purpose():
    line, _ = write(session_count=3)

    assert line["session_count"] == REDACTED


@pytest.mark.parametrize("kind", KINDS)
def test_args_mappings_and_tuples_are_redacted(kind):
    secret = SENTINELS[kind]

    mapped, raw_mapped = write("seen %(" + kind + ")s", {kind: secret})
    _, raw_tupled = write("seen %s", {kind: secret})
    plain, raw_plain = write("seen %s and %s", f"{kind}={secret}", "ok")

    assert_clean(raw_mapped, secret)
    assert_clean(raw_tupled, secret)
    assert_clean(raw_plain, secret)
    assert mapped["message"].startswith("seen ")
    assert plain["message"].endswith(" and ok")


def test_a_record_that_was_redacted_still_reaches_the_other_handlers_unchanged(caplog):
    with capture_logs():
        logger.info("password=SAME-AS-LOGGED")

    assert "password=SAME-AS-LOGGED" in caplog.text  # caplog's handler gets the original


# --- text ---


def forms(kind: str, secret: str) -> list[str]:
    return [
        f"{kind}={secret}",
        f"x {kind}={secret} y",
        f"a=1&{kind}={secret}&b=2",
        f"{kind}: {secret}",
        f"{kind}:{secret}",
        f"'{kind}': '{secret}'",
        f'"{kind}": "{secret}"',
        f"{{'{kind}': '{secret}', 'ok': 1}}",
        f'{{"{kind}": "{secret}", "ok": 1}}',
        f"{kind.upper()}={secret}",
        f"prefix_{kind}_suffix={secret}",
        f"https://example.test/x?{kind}={secret}",
        f"GET /api/path?{kind}={secret} HTTP/1.1",
        f"/x?a=b&{kind}={secret}#frag",
        f"input_value={{'{kind}': '{secret}'}}, input_type=dict",
        f"Cookie: {kind}={secret}; other=1",
        f"Set-Cookie: {kind}={secret}; Path=/; HttpOnly",
        f"Authorization: Bearer {secret}",
        f"Authorization: Basic {secret}",
        f"Bearer {secret}",
        f"line one\nCookie: {secret}\nline three",
    ]


@pytest.mark.parametrize("kind", KINDS)
def test_every_text_form_is_masked_in_the_message(kind):
    secret = SENTINELS[kind]

    for text in forms(kind, secret):
        _, raw = write(text)

        assert secret not in raw, text
        assert REDACTED in raw or "?" in text, text
        assert len(raw.splitlines()) == 1


@pytest.mark.parametrize("kind", KINDS)
def test_every_text_form_is_masked_in_a_string_field_and_in_a_stack_trace(kind):
    secret = SENTINELS[kind]

    for text in forms(kind, secret):
        with capture_logs() as stream:
            try:
                raise ValueError(text)
            except ValueError:
                logger.exception("failed", extra={"detail": text, "nested": {"list": [text]}})
        (line,) = lines_of(stream)

        assert secret not in stream.getvalue(), text
        assert "stack_trace" in line and "ValueError" in line["stack_trace"]
        assert len(stream.getvalue().splitlines()) == 1


def test_bearer_cookie_and_session_text_forms_are_replaced_with_the_marker():
    assert redact_text("Authorization: Bearer abc.def") == f"Authorization: {REDACTED}"
    assert redact_text("token Bearer abc.def end") == f"token Bearer {REDACTED} end"
    assert redact_text("Cookie: session=abc; a=b") == f"Cookie: {REDACTED}"
    assert redact_text("Set-Cookie: session=abc; Path=/") == f"Set-Cookie: {REDACTED}"
    assert redact_text("session=abc rest") == f"session={REDACTED} rest"
    assert redact_text("{'password': 'p w', 'a': 1}") == f"{{'password': {REDACTED}, 'a': 1}}"
    assert redact_text('"token": "t1", "b": 2') == f'"token": {REDACTED}, "b": 2'


def test_the_query_string_of_a_url_or_path_is_removed():
    assert redact_text("GET /x?a=b HTTP/1.1") == "GET /x HTTP/1.1"
    assert (
        redact_text("see https://example.test/a/b?q=1&r=2 now")
        == "see https://example.test/a/b now"
    )
    assert redact_text("'/path?x=1'") == "'/path'"
    assert redact_text("plain text? yes") == "plain text? yes"


def test_text_without_secrets_is_left_alone():
    for text in (
        "Quiz attempt graded: course_id=alpha-course chapter_id=01-first score=4 total=5 outcome=passed",
        "Feedback stored: course_id=none category=bug",
        "Login limit reached: scope=ip",
        "loaded course alpha-course: 2 chapters, 3 lessons",
        "request completed",
        "Started server process [12]",
    ):
        assert redact_text(text) == text


def test_a_very_long_string_is_redacted_in_linear_time():
    text = "a" * 200_000 + " session=" + "x" * 1000

    result = redact_text(text)

    assert "x" * 1000 not in result and result.endswith(REDACTED)


def test_redact_value_handles_odd_values():
    class Unprintable:
        def __str__(self):
            raise RuntimeError("no")

    cyclic: list = []
    cyclic.append(cyclic)

    value = redact_value({"a": b"token=BYTES-1", 1: Unprintable(), "c": cyclic, "d": {"x"}})

    assert "BYTES-1" not in json.dumps(value, default=str)
    assert value["1"] == "<unprintable>"


# --- the line stays valid ---


def test_a_message_with_newlines_quotes_and_non_ascii_text_is_one_line_that_parses_back():
    text = 'first "quoted" line\nsecond line with \\ and tab\t and é, ü, 漢字, and 🙂'

    line, raw = write(text)

    assert line["message"] == text
    assert len(raw.splitlines()) == 1
