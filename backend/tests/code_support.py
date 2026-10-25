"""Names and helpers shared by the code step and chapter ZIP tests (#59).

`zeta-course` of the fixture build has six chapters of one lesson each:

| chapter         | `free_preview` | code                        | for a new learner |
|-----------------|----------------|-----------------------------|-------------------|
| `01-open`       | yes            | three steps (see below)     | `in_progress`     |
| `02-gated`      | no             | three steps                 | `locked`          |
| `03-sealed`     | no             | two steps                   | `locked`          |
| `04-late-open`  | yes            | two steps                   | `locked`          |
| `05-plain`      | no             | none                        | `locked`          |
| `06-open-plain` | yes            | none                        | `locked`          |

Every code file holds `CODE-SENTINEL-<chapter>`. The JSON and the real ZIP of each code chapter
were written by the content build (`writeCodeSteps`), so the hash and size in the JSON are real.
`01-open` has `Z.py`, `a.py` and `old.py` in step 1; step 2 modifies `a.py`, deletes `old.py`, and
adds `pkg/__init__.py` and `pkg/util.py`; step 3 keeps `Z.py`, `a.py`, and `pkg/__init__.py`
unchanged and modifies `pkg/util.py`. `alpha-course` is served next to it for tests of a chapter
ID from another course.
"""

import json
from pathlib import Path

from tests.course_support import FIXTURE_BUILD

COURSE = "zeta-course"
COURSES = "zeta-course,alpha-course"
CHAPTERS = ["01-open", "02-gated", "03-sealed", "04-late-open", "05-plain", "06-open-plain"]
CODE_CHAPTERS = ["01-open", "02-gated", "03-sealed", "04-late-open"]
NO_STORE = "private, no-store"
ZIP_TYPE = "application/zip"


def code_url(chapter: str, course: str = COURSE) -> str:
    return f"/api/courses/{course}/chapters/{chapter}/code"


def zip_url(chapter: str, course: str = COURSE) -> str:
    return f"{code_url(chapter, course)}.zip"


def code_dir(build: Path = FIXTURE_BUILD, course: str = COURSE) -> Path:
    return build / "private" / "code" / course


def read_code_file(chapter: str, build: Path = FIXTURE_BUILD, course: str = COURSE) -> dict:
    return json.loads((code_dir(build, course) / f"{chapter}.json").read_text(encoding="utf-8"))


def write_code_file(chapter: str, document: object, build: Path, course: str = COURSE) -> None:
    path = code_dir(build, course) / f"{chapter}.json"
    path.write_text(json.dumps(document), encoding="utf-8")


def zip_on_disk(chapter: str, build: Path = FIXTURE_BUILD, course: str = COURSE) -> Path:
    return code_dir(build, course) / read_code_file(chapter, build, course)["zip"]["file"]


def sentinel(chapter: str) -> str:
    return f"CODE-SENTINEL-{chapter}"
