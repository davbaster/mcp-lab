"""Names and helpers shared by the asset tests (#58).

The fixture build (`tests/fixtures/course-build`) has, under `alpha-course`, one file per extension
named `asset-<16 hex>.<ext>` that holds the text `ASSET-SENTINEL-alpha-<ext>`, an SVG, a `.png`
that holds HTML, a zero-byte `.vtt`, a name with a dot and capitals, and a stray file that is on
disk but not in the map. `beta-course` has a `.png` with the same name as alpha's but other bytes,
and one file of its own. `unlisted-course` has a valid map and a file but is not in `COURSES`.
"""

import hashlib
import json
from pathlib import Path

from tests.course_support import FIXTURE_BUILD

ALPHA = "alpha-course"
BETA = "beta-course"
ASSETS = "/api/courses/{course}/assets/{name}"

# extension -> (hashed name in alpha-course, Content-Type)
BY_EXTENSION = {
    "png": ("asset-a8520c30dc8ccbb2.png", "image/png"),
    "jpg": ("asset-72be49cfe5aac953.jpg", "image/jpeg"),
    "jpeg": ("asset-b07a5dc697914ea0.jpeg", "image/jpeg"),
    "webp": ("asset-68cc6c09e814987f.webp", "image/webp"),
    "svg": ("asset-fb4dad124333c90d.svg", "image/svg+xml"),
    "glb": ("asset-c81a99bbdafa8cca.glb", "model/gltf-binary"),
    "gltf": ("asset-6a7093b8ce35bbeb.gltf", "model/gltf+json"),
    "vtt": ("asset-874f2e07dd50ab6f.vtt", "text/vtt; charset=utf-8"),
}
EXTENSIONS = list(BY_EXTENSION)

PNG = BY_EXTENSION["png"][0]  # also the name of a different file in beta-course
SVG = BY_EXTENSION["svg"][0]
VTT = BY_EXTENSION["vtt"][0]
HTML_PNG = "trick-a1c534d96b208930.png"  # a .png whose bytes are HTML
EMPTY_VTT = "empty-e3b0c44298fc1c14.vtt"
DOTTED = "My.Photo-d7d61f9c51b2c969.png"
STRAY = "stray-0123456789abcdef.png"  # on disk in alpha-course, not in its map
BETA_ONLY = "only-beta-0ed023b7ab5101de.png"
UNLISTED_FILE = "hidden-8962260f3e41e2a1.png"  # in unlisted-course

NO_STORE = "private, no-store"
CACHE_CONTROL = "public, max-age=31536000, immutable"
SVG_POLICY = "script-src 'none'; default-src 'none'; style-src 'unsafe-inline'; sandbox"


def url(course: str, name: str) -> str:
    return ASSETS.format(course=course, name=name)


def file_on_disk(course: str, name: str, build: Path = FIXTURE_BUILD) -> Path:
    return build / "public" / "assets" / course / name


def read_map(course: str, build: Path = FIXTURE_BUILD) -> dict:
    return json.loads((build / "assets-map" / f"{course}.json").read_text(encoding="utf-8"))


def map_entries(course: str, build: Path = FIXTURE_BUILD) -> dict[str, dict]:
    """The entries of a course's map by hashed file name (two paths with one file are one entry)."""
    return {entry["file"]: entry for entry in read_map(course, build)["files"].values()}


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()
