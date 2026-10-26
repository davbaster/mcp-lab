"""Exact route paths: a path that ends in a newline is not the path without it (#111).

Starlette compiles every route into a regex that ends in `$`, and in Python `$` also matches just
before one final `\\n`. uvicorn decodes `%0a` to `\\n` before routing, so `GET /api/health%0a`
would run the `/api/health` route. The alias answers like the real path, but a log line, a metric
label, a proxy rule or a cache key sees a different path. `install_strict_paths` ends each route's
regex in `\\Z` instead (the end of the string, nothing else), so the alias matches no route and
gets the shared 404 `not_found`.

A route whose last part is a parameter is left alone: `lessons/{lesson_id}` and
`assets/{file_name}` take the newline as part of the ID, which is a miss in the catalog or the
asset map with the route's own error code (`lesson_not_found`, `asset_not_found`). The `[\\s\\S]*`
converters of the asset and code routes are separate and stay: they are what gives those routes
their own codes for an odd ID (including a newline) instead of the generic `not_found`.
"""

import re

from fastapi import FastAPI

_LINE_END = "$"
_STRING_END = r"\Z"


def install_strict_paths(app: FastAPI) -> None:
    """End the path regex of every route of `app` that ends in a literal in `\\Z`, not `$`.

    Call it once, after the last route is added: a route added later keeps the `$`, and
    `tests/test_route_paths.py` fails for it.
    """
    for route in app.router.routes:
        pattern = getattr(route, "path_regex", None)
        if pattern is None or getattr(route, "path_format", "").endswith("}"):
            continue
        if pattern.pattern.endswith(_LINE_END):
            route.path_regex = re.compile(pattern.pattern[: -len(_LINE_END)] + _STRING_END)
