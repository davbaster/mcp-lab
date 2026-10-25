"""Course assets: read the asset map of the content build at startup and keep it in memory.

The content build writes `public/assets/<course_id>/<stem>-<16 hex>.<ext>` and
`assets-map/<course_id>.json` (`content-build/README.md`, "Assets"). `read_assets` reads the map of
one course and turns it into a frozen dictionary `hashed file name -> Asset`. That dictionary is
the allowlist of the asset route (`app.asset_routes`): a request is answered only when its file
name is exactly a key of it. The source paths of the map (`images/pic.png`) are not used.

Every key was checked here against a strict pattern that has no `/`, `\\`, `..`, or control
character, and the file it names was checked to be a regular file directly inside the course's
asset folder. So the path on disk, `<build>/public/assets/<course_id>/<file>`, is built only from a
course ID that is in the catalog and a name that passed these checks, never from a request string.

The bytes of the files are not read, so a 25 MiB model does not slow the start: only the size is
compared with the map. Any problem raises `AssetMapError` at the first one; `app.courses` turns it
into the `CourseLoadError` that stops the app. Messages hold course IDs, field names, and paths
inside the build folder only, never the content of the map.
"""

import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, ValidationError

# The extension decides the type, never `mimetypes`, the bytes, or the request: `mimetypes` answers
# differently on Windows, macOS, and Linux for `.glb` and `.vtt`. The build writes only these eight.
CONTENT_TYPES = MappingProxyType(
    {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
        ".vtt": "text/vtt; charset=utf-8",
    }
)

# A hashed file name as the content build writes it. No separator, no `..`, no hidden or empty
# stem, a lower-case hash and extension, and one of the eight extensions.
FILE_NAME = re.compile(
    r"[A-Za-z0-9_-][A-Za-z0-9._-]*-[0-9a-f]{16}\.(?:png|jpg|jpeg|webp|svg|glb|gltf|vtt)"
)
_SHA256 = re.compile(r"[0-9a-f]{64}")
_MAX_SHOWN = 200


class AssetMapError(Exception):
    """The asset map of a course cannot be loaded. The message says what is wrong and where."""


@dataclass(frozen=True)
class Asset:
    """What the route needs to know about one file: all of it from the map."""

    file: str
    content_type: str
    sha256: str
    size: int


class _MapEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    file: StrictStr
    sha256: StrictStr
    size: Annotated[StrictInt, Field(ge=0)]


class _AssetMap(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: StrictStr
    files: dict[StrictStr, _MapEntry]


def map_path(course_id: str) -> str:
    """The map's path inside the build folder, as the messages write it."""
    return f"assets-map/{course_id}.json"


def asset_dir(course_id: str) -> str:
    return f"public/assets/{course_id}"


def _field(loc: tuple[Any, ...]) -> str:
    text = ""
    for part in loc:
        if isinstance(part, int):
            text += f"[{part}]"
        elif text == "files":  # a key of the `files` object: a source path
            text += f"[{part!r}]"
        else:
            text += f".{part}" if text else str(part)
    text = text or "(top level)"
    return text if len(text) <= _MAX_SHOWN else text[: _MAX_SHOWN - 3] + "..."


def _read_document(build_dir: Path, course_id: str) -> Any:
    relative = map_path(course_id)
    path = build_dir / relative
    if not path.is_file():
        raise AssetMapError(
            f"No asset map for the course {course_id}: {relative} is not a file in "
            "COURSE_BUILD_DIR. Run the content build again (make build-content)."
        )
    try:
        return json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, ValueError, RecursionError) as error:
        reason = "cannot be read" if isinstance(error, OSError) else "is not valid UTF-8 JSON"
        raise AssetMapError(f"{relative} {reason} (course {course_id}).") from None


def _parse(document: Any, course_id: str) -> _AssetMap:
    relative = map_path(course_id)
    if not isinstance(document, dict):
        raise AssetMapError(f"{relative}: the top level must be a JSON object.")
    try:
        parsed = _AssetMap.model_validate(document)
    except ValidationError as error:
        first = error.errors()[0]  # location and message only: never the input
        raise AssetMapError(f"{relative}: field {_field(first['loc'])}: {first['msg']}.") from None
    if parsed.course_id != course_id:
        shown = parsed.course_id if len(parsed.course_id) <= _MAX_SHOWN else "(too long)"
        raise AssetMapError(
            f"{relative}: field course_id is {shown!r}, but the file is for the course "
            f"{course_id} (COURSES entry)."
        )
    return parsed


def _check_file_on_disk(build_dir: Path, course_id: str, asset: Asset) -> None:
    """The listed file is a regular file directly inside the course's asset folder, of this size."""
    relative = f"{asset_dir(course_id)}/{asset.file}"
    path = build_dir / relative
    try:
        info = os.lstat(path)
    except OSError:
        raise AssetMapError(
            f"The course {course_id} lists the asset {relative}, which is not a file in "
            "COURSE_BUILD_DIR."
        ) from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise AssetMapError(
            f"The course {course_id} lists the asset {relative}, which is not a regular file "
            "(a folder or a symbolic link)."
        )
    folder = Path(os.path.realpath(build_dir / asset_dir(course_id)))
    if Path(os.path.realpath(path)).parent != folder:
        raise AssetMapError(
            f"The course {course_id} lists the asset {relative}, which is not directly inside "
            f"{asset_dir(course_id)}."
        )
    if info.st_size != asset.size:
        raise AssetMapError(
            f"The course {course_id} lists the asset {relative} with size {asset.size}, but the "
            f"file has {info.st_size} bytes."
        )


def read_assets(build_dir: Path, course_id: str) -> "MappingProxyType[str, Asset]":
    """The assets of `course_id` from `assets-map/<course_id>.json`, checked against the disk.

    Raises `AssetMapError` at the first problem. Reads the map and the file metadata, never the
    bytes of an asset.
    """
    relative = map_path(course_id)
    parsed = _parse(_read_document(build_dir, course_id), course_id)
    assets: dict[str, Asset] = {}
    for source, entry in parsed.files.items():
        where = _field(("files", source))
        if not FILE_NAME.fullmatch(entry.file):
            raise AssetMapError(
                f"{relative}: field {where}.file is not a hashed asset file name "
                "(<name>-<16 hex digits>.<png|jpg|jpeg|webp|svg|glb|gltf|vtt>)."
            )
        if not _SHA256.fullmatch(entry.sha256):
            raise AssetMapError(
                f"{relative}: field {where}.sha256 is not 64 lower-case hex digits."
            )
        asset = Asset(
            file=entry.file,
            content_type=CONTENT_TYPES[PurePosixPath(entry.file).suffix],
            sha256=entry.sha256,
            size=entry.size,
        )
        known = assets.get(asset.file)
        if known is not None and known != asset:
            # The build writes two source paths with equal bytes and the same stem as one file.
            # The same name with other bytes would make the name ambiguous.
            raise AssetMapError(
                f"{relative}: field {where}.file: the file name is used by another entry with "
                "a different sha256 or size."
            )
        assets[asset.file] = asset
    for asset in assets.values():
        _check_file_on_disk(build_dir, course_id, asset)
    return MappingProxyType(assets)
