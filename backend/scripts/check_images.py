"""Build the backend and frontend images and check what is in them.

Run from backend/ (or `make check-images` from the repo root):  uv run python scripts/check_images.py

1. The backend image is built with the fixture course instead of `courses/` (`--build-arg
   COURSES_DIR=content-build/fixtures/valid`). The script runs it and finds the build output of
   that course in $COURSE_BUILD_DIR, readable by the image's non-root user.
2. The frontend image is built and searched for course data: no folder named `private` or
   `course-build`, and no file `01-first-steps.json` or `sample-course.json`, anywhere in its file system.
   The same search in the backend image must find all four, so a search that finds nothing would not pass.

It needs Docker and fails (never skips) when Docker is missing or not running. It removes the images and
containers it made, also when a check fails.
"""

import shutil
import subprocess
import sys
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURE_COURSES = "content-build/fixtures/valid"
BUILD_TIMEOUT = 20 * 60
RUN_TIMEOUT = 2 * 60

# What the backend image holds for the fixture course, relative to $COURSE_BUILD_DIR. `*` stands for one file name.
EXPECTED_FILES = (
    "private/courses/sample-course.json",
    "private/lessons/sample-course/*",
    "private/quizzes/sample-course/01-first-steps.json",
    "public/assets/sample-course/*",
)

# The names that must not be in the frontend image. Run with `find`, so it must work with busybox too.
# /etc/ssl/private is a folder of the base images (empty, for private keys); it is allowed only if it stays empty.
SYSTEM_PRIVATE = "/etc/ssl/private"
SEARCH_SCRIPT = f"""
find / -xdev \\( -type d \\( -name private -o -name course-build \\) \\
  -o -type f \\( -name 01-first-steps.json -o -name sample-course.json \\) \\) \\
  ! -path {SYSTEM_PRIVATE} 2>/dev/null | sed 's/^/found /'
find {SYSTEM_PRIVATE} -mindepth 1 2>/dev/null | sed 's/^/found /'
true
"""

LISTING_SCRIPT = """
echo "user $(id -u)"
echo "dir $COURSE_BUILD_DIR"
cd "$COURSE_BUILD_DIR"
find . -type f | sed 's|^\\./|file |' | sort
find . ! -readable | sed 's|^\\./|unreadable |'
true
"""

NEEDED_BY_THE_SEARCH = ("/private", "/course-build", "/01-first-steps.json", "/sample-course.json")


class CheckError(Exception):
    """A check failed, or Docker is not usable. The message is for the person running the script."""


def lines_with(prefix: str, output: str) -> list[str]:
    return [line[len(prefix) :] for line in output.splitlines() if line.startswith(prefix)]


def backend_problems(listing: str, search: str) -> list[str]:
    """What is wrong with the output of LISTING_SCRIPT and of SEARCH_SCRIPT run in the backend image."""
    problems = []
    users = lines_with("user ", listing)
    if users != [u for u in users if u.isdigit() and u != "0"] or not users:
        problems.append(f"the backend image must run as a non-root user, but `id -u` printed {users}")
    if lines_with("dir ", listing) != ["/app/course-build"]:
        problems.append(f"COURSE_BUILD_DIR must be /app/course-build, but is {lines_with('dir ', listing)}")
    files = lines_with("file ", listing)
    for expected in EXPECTED_FILES:
        if expected.endswith("*"):
            found = any(f.startswith(expected[:-1]) for f in files)
        else:
            found = expected in files
        if not found:
            problems.append(f"the backend image has no file {expected} in $COURSE_BUILD_DIR")
    for name in lines_with("unreadable ", listing):
        problems.append(f"{name} in $COURSE_BUILD_DIR is not readable by the image's user")
    # The positive control: the search that must find nothing in the frontend finds all four names here.
    hits = lines_with("found ", search)
    for needle in NEEDED_BY_THE_SEARCH:
        if not any(hit.endswith(needle) for hit in hits):
            problems.append(f"the search found no {needle[1:]} in the backend image, so it cannot be trusted")
    return problems


def frontend_problems(search: str) -> list[str]:
    """What is wrong with the output of SEARCH_SCRIPT run in the frontend image: it must find nothing."""
    return [f"the frontend image has {hit}" for hit in lines_with("found ", search)]


def docker(*args: str, timeout: int = RUN_TIMEOUT) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["docker", *args],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise CheckError(f"`docker {' '.join(args[:2])}` took longer than {timeout} seconds") from error


def require_docker() -> None:
    if shutil.which("docker") is None:
        raise CheckError("Docker is required: the `docker` command was not found. Install and start Docker.")
    info = docker("info", "--format", "{{.ServerVersion}}")
    if info.returncode != 0:
        raise CheckError(f"Docker is not running or not reachable: {info.stderr.strip() or info.stdout.strip()}")


def build(tag: str, *args: str) -> None:
    print(f"building {tag} ...", flush=True)
    result = docker("build", *args, "-t", tag, timeout=BUILD_TIMEOUT)
    if result.returncode != 0:
        raise CheckError(f"`docker build` for {tag} failed:\n{(result.stdout + result.stderr)[-4000:]}")


def run_script(image: str, name: str, script: str) -> str:
    """Runs `sh -c script` in a new container of `image` (as the image's own user) and returns its output."""
    result = docker("run", "--rm", "--name", name, "--entrypoint", "sh", image, "-c", script)
    if result.returncode != 0:
        raise CheckError(f"running a check in {image} failed ({result.returncode}): {result.stderr.strip()}")
    return result.stdout


def main() -> int:
    suffix = uuid.uuid4().hex[:8]
    backend_image = f"mcp-lab-check-backend:{suffix}"
    frontend_image = f"mcp-lab-check-frontend:{suffix}"
    containers = [f"mcp-lab-check-{suffix}-{kind}" for kind in ("backend-list", "backend-search", "frontend-search")]
    problems: list[str] = []
    try:
        require_docker()
        build(backend_image, "-f", "backend/Dockerfile", "--build-arg", f"COURSES_DIR={FIXTURE_COURSES}", ".")
        build(frontend_image, "-f", "frontend/Dockerfile", ".")

        listing = run_script(backend_image, containers[0], LISTING_SCRIPT)
        backend_search = run_script(backend_image, containers[1], SEARCH_SCRIPT)
        frontend_search = run_script(frontend_image, containers[2], SEARCH_SCRIPT)
        problems = backend_problems(listing, backend_search) + frontend_problems(frontend_search)
    except CheckError as error:
        problems = [str(error)]
    finally:
        for container in containers:
            if shutil.which("docker"):
                docker("rm", "-f", container)
        if shutil.which("docker"):
            for image in (backend_image, frontend_image):
                docker("rmi", "-f", image)

    if problems:
        print("check-images FAILED:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    print("check-images ok: the backend image holds the fixture course's build output, the frontend image holds no course data")
    return 0


if __name__ == "__main__":
    sys.exit(main())
