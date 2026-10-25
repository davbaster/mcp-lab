"""The app, as the real-server tests of #36 start it (`uvicorn tests.obs_server_app:app`).

It is `app.main.app` plus two routes that fail on purpose, and, when `OBS_BREAK_ATTEMPTS=1`, a
quiz attempt that Postgres refuses with a CHECK violation (the failing row goes in the database
error, which the app must keep out of its log). Nothing here is part of the product.
"""

import os

from pydantic import BaseModel

import app.quiz_routes as routes
from app.main import app


class Item(BaseModel):
    n: int


BAD_RESPONSE = "RESPONSE-SENTINEL-" + "e2e"


@app.get("/api/test/boom")
def boom() -> None:
    raise RuntimeError("it failed with password=PW-SENTINEL-boom and a trace")


@app.get("/api/test/invalid-response", response_model=Item)
def invalid_response():
    return {"n": BAD_RESPONSE}


if os.environ.get("OBS_BREAK_ATTEMPTS") == "1":
    real = routes.record_attempt

    def record_under_a_bad_chapter_id(db, **kwargs):
        return real(db, **{**kwargs, "chapter_id": "BAD CHAPTER ID"})

    routes.record_attempt = record_under_a_bad_chapter_id
