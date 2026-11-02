"""Look inside the real backend and frontend images that CI is about to publish (#77).

Run from backend/ (or `make check-image-contents BACKEND_IMAGE=<ref> FRONTEND_IMAGE=<ref>` from the repo root):
    uv run python scripts/check_image_contents.py <backend image> <frontend image>

Both images must already exist in the local Docker daemon. Unlike check_images.py (which builds its own images from fixture
courses), this checks the images as they are built from `courses/`:

1. Neither image holds an env file (`.env`, `.env.*`, `*.env`) anywhere in its file system.
2. The frontend image holds no quiz data: no folder named `private` or `course-build`, and no file with the name of any quiz
   file found in the backend image. The empty system folder /etc/ssl/private of the base images is allowed. The backend image
   must hold at least one quiz file, so a search that finds nothing cannot pass.

(Secrets inside files are Trivy's job: its image scan runs the secret scanner too.)

It needs Docker and fails (never skips) when Docker is missing or not running.
"""

import sys

from check_images import CheckError, lines_with, require_docker, run_script

QUIZ_DIR = "/app/course-build/private/quizzes"
SYSTEM_PRIVATE = "/etc/ssl/private"

# `find` must work with busybox too (the frontend image is Alpine).
ENV_FILES_SCRIPT = """
find / -xdev -type f \\( -name '.env' -o -name '.env.*' -o -name '*.env' \\) 2>/dev/null | sed 's/^/found /'
true
"""

QUIZ_LISTING_SCRIPT = f"""
find {QUIZ_DIR} -type f 2>/dev/null | sed 's|^.*/|quiz |'
echo "user $(id -u)"
true
"""


def frontend_search_script(quiz_names: list[str]) -> str:
    """A `find` for the folders and the quiz file names that must not be in the frontend image."""
    names = " -o ".join(f"-name '{name}'" for name in quiz_names)
    return f"""
find / -xdev \\( -type d \\( -name private -o -name course-build \\) \\
  -o -type f \\( {names} \\) \\) \\
  ! -path {SYSTEM_PRIVATE} 2>/dev/null | sed 's/^/found /'
find {SYSTEM_PRIVATE} -mindepth 1 2>/dev/null | sed 's/^/found /'
true
"""


def env_file_problems(image_name: str, output: str) -> list[str]:
    return [f"the {image_name} image has the env file {hit}" for hit in lines_with("found ", output)]


def quiz_problems(listing: str) -> list[str]:
    """What is wrong with the backend image's quiz listing (the positive control of the frontend search)."""
    users = lines_with("user ", listing)
    problems = []
    if not users or any(not user.isdigit() or user == "0" for user in users):
        problems.append(f"the backend image must run as a non-root user, but `id -u` printed {users}")
    if not lines_with("quiz ", listing):
        problems.append(f"the backend image has no quiz file in {QUIZ_DIR}, so the search for quiz data in the frontend cannot be trusted")
    return problems


def frontend_problems(search: str) -> list[str]:
    return [f"the frontend image has {hit}" for hit in lines_with("found ", search)]


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: check_image_contents.py <backend image> <frontend image>", file=sys.stderr)
        return 2
    backend_image, frontend_image = argv[1], argv[2]
    problems: list[str] = []
    try:
        require_docker()
        problems += env_file_problems("backend", run_script(backend_image, "mcp-lab-contents-backend-env", ENV_FILES_SCRIPT))
        problems += env_file_problems("frontend", run_script(frontend_image, "mcp-lab-contents-frontend-env", ENV_FILES_SCRIPT))
        listing = run_script(backend_image, "mcp-lab-contents-backend-quizzes", QUIZ_LISTING_SCRIPT)
        problems += quiz_problems(listing)
        quiz_names = sorted(set(lines_with("quiz ", listing)))
        if quiz_names:
            search = run_script(frontend_image, "mcp-lab-contents-frontend-quizzes", frontend_search_script(quiz_names))
            problems += frontend_problems(search)
    except CheckError as error:
        problems += [str(error)]

    if problems:
        print("check-image-contents FAILED:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    print("check-image-contents ok: no env file in either image, and no quiz data in the frontend image")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
