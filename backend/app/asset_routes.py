"""The asset route: a course's built images, diagrams, models, and captions, served as files.

`GET /api/courses/{course_id}/assets/{file_name}` is public (no login, no session lookup, no
database connection, no cookie): the hashed names are in the lesson trees, which the content-access
rule guards, and the files hold no answer keys. The answer is the same for everyone, so it is
`public` and cached for a year; the name holds the hash of the bytes, so it never changes.

The asset map is the allowlist. `file_name` is only a key of the dictionary of the course in the
URL (`Course.get_asset`); it is never joined into a path. The path on disk is built from the course
ID in the catalog and the name of the asset, which was checked when the app started
(`app.assets`). Header rules (decided in #58):

- `Content-Type` comes from the extension (a fixed table), not from the bytes.
- `X-Content-Type-Options: nosniff` on every type; `Content-Disposition: inline` with no file name.
- `.svg` also gets a `Content-Security-Policy` that lets no script run and sandboxes the document.
- The `ETag` is the SHA-256 from the map, and `If-None-Match` is answered with a 304.
- `Range` and `If-Range` are ignored: the answer is always 200 with the whole file.
"""

import os
import stat
from typing import Annotated

from fastapi import Depends, FastAPI, Request
from fastapi.responses import FileResponse, Response
from starlette.convertors import Convertor, register_url_convertor
from starlette.types import Receive, Scope, Send

from app.assets import CONTENT_TYPES, Asset
from app.content import BuildFileError
from app.course_routes import COURSE_NOT_FOUND_MESSAGE
from app.courses import Catalog, Course, get_catalog
from app.errors import ApiError, ErrorResponse

ASSET_NOT_FOUND_MESSAGE = "Asset not found."
CACHE_CONTROL = "public, max-age=31536000, immutable"
SVG_POLICY = "script-src 'none'; default-src 'none'; style-src 'unsafe-inline'; sandbox"
_SVG_TYPE = "image/svg+xml"


class _AnyNameConvertor(Convertor[str]):
    """The rest of the path, every character included.

    Starlette's own `path` convertor is `.*`, which does not match a newline, and the router's
    pattern ends in `$`, which matches before a final newline. So `name%0a` would reach the handler
    as `name` and be served. This pattern takes the newline into the name, and the name is then a
    miss in the dictionary like any other. A `/` in the name is also part of it, so it gets
    `asset_not_found` and not the router's generic `not_found`.
    """

    regex = r"[\s\S]*"

    def convert(self, value: str) -> str:
        return value

    def to_string(self, value: str) -> str:
        return value


register_url_convertor("asset_name", _AnyNameConvertor())


class WholeFileResponse(FileResponse):
    """A file response that ignores `Range` and `If-Range`, so the answer is always the whole file.

    Starlette answers a bad range with a plain-text 400 or 416, which would break the shared error
    shape, and a good one with a 206 that the spec does not list.
    """

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            headers = [(k, v) for k, v in scope["headers"] if k not in (b"range", b"if-range")]
            scope = {**scope, "headers": headers}
        await super().__call__(scope, receive, send)


def resolve_asset(catalog: Catalog, course_id: str, file_name: str) -> tuple[Course, Asset]:
    """The course and asset for these two request strings, else a 404 `ApiError`.

    The course comes first. Nothing is read from disk: both are dictionary lookups.
    """
    course = catalog.get(course_id)
    if course is None:
        raise ApiError(404, "course_not_found", COURSE_NOT_FOUND_MESSAGE)
    asset = course.get_asset(file_name)
    if asset is None:
        raise ApiError(404, "asset_not_found", ASSET_NOT_FOUND_MESSAGE)
    return course, asset


def etag_of(asset: Asset) -> str:
    return f'"{asset.sha256}"'


def asset_headers(asset: Asset) -> dict[str, str]:
    """The headers of a 200 and of a 304 for this asset."""
    headers = {
        "cache-control": CACHE_CONTROL,
        "etag": etag_of(asset),
        "x-content-type-options": "nosniff",
        "content-disposition": "inline",
        "accept-ranges": "none",
    }
    if asset.content_type == _SVG_TYPE:
        headers["content-security-policy"] = SVG_POLICY
    return headers


def etag_matches(header: str | None, asset: Asset) -> bool:
    """Whether an `If-None-Match` value names this asset: `*`, or a list that holds its ETag.

    The weak form `W/"..."` is compared by its value (the comparison `If-None-Match` uses).
    """
    if header is None:
        return False
    for candidate in header.split(","):
        candidate = candidate.strip()
        if candidate == "*":
            return True
        candidate = candidate.removeprefix("W/")
        if candidate == etag_of(asset):
            return True
    return False


def get_asset(
    course_id: str,
    file_name: str,
    request: Request,
    catalog: Annotated[Catalog, Depends(get_catalog)],
) -> Response:
    course, asset = resolve_asset(catalog, course_id, file_name)
    headers = asset_headers(asset)
    if etag_matches(",".join(request.headers.getlist("if-none-match")) or None, asset):
        return Response(status_code=304, headers=headers)
    path = catalog.build_dir / "public" / "assets" / course.id / asset.file
    try:
        info = os.stat(path)
        if not stat.S_ISREG(info.st_mode):
            raise OSError
    except OSError:
        # In the map at startup and gone now: a server fault. The message names no path.
        raise BuildFileError(
            f"Asset file (course {course.id}, file {asset.file}): "
            "the file is missing or cannot be read."
        ) from None
    return WholeFileResponse(path, headers=headers, media_type=asset.content_type, stat_result=info)


def _header(description: str) -> dict[str, object]:
    return {"description": description, "schema": {"type": "string"}}


_HEADERS = {
    "Cache-Control": _header(
        "Always `public, max-age=31536000, immutable`: the opposite of the `private, no-store` "
        "header of the other routes. The name holds the hash of the bytes, so the file under a "
        "name never changes and any cache may keep it."
    ),
    "ETag": _header("The SHA-256 of the file in double quotes, the same for every request."),
    "X-Content-Type-Options": _header("Always `nosniff`, on every type."),
    "Content-Disposition": _header("Always `inline`, with no file name."),
    "Accept-Ranges": _header("Always `none`: a `Range` header is ignored."),
    "Content-Security-Policy": _header(
        "Sent on an SVG only (not on other types): "
        "`script-src 'none'; default-src 'none'; style-src 'unsafe-inline'; sandbox`."
    ),
}
_BINARY = {"schema": {"type": "string", "format": "binary"}}
_MEDIA_TYPES = sorted({value.split(";")[0] for value in CONTENT_TYPES.values()})


def install_asset_routes(app: FastAPI) -> None:
    """Add the asset route to `app`."""
    app.add_api_route(
        "/api/courses/{course_id}/assets/{file_name:asset_name}",
        get_asset,
        methods=["GET"],
        response_class=Response,
        tags=["courses"],
        operation_id="getAsset",
        responses={
            200: {
                "description": "The file, exactly as the content build wrote it.",
                "content": {media_type: _BINARY for media_type in _MEDIA_TYPES},
                "headers": _HEADERS,
            },
            304: {
                "description": "The `If-None-Match` header names this file's ETag. No body.",
                "headers": {k: v for k, v in _HEADERS.items() if k != "Accept-Ranges"},
            },
            404: {"model": ErrorResponse},
        },
        summary="A built asset of a course (image, diagram, 3D model, or caption file), public",
    )
