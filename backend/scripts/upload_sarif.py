"""Upload Trivy's SARIF files to the repository's Security tab (code scanning) with the workflow's GITHUB_TOKEN (#77).

Run from backend/ (or `make upload-sarif` from the repo root):  uv run python scripts/upload_sarif.py <file.sarif> ...

This is what `github/codeql-action/upload-sarif` does, without adding that action: one POST per file to
`/repos/{repo}/code-scanning/sarifs`. The category of each upload is the file name without `.sarif`, so the scans do not
replace each other. A file that does not exist is skipped (an earlier step failed before writing it); with no file at all the
script prints that and succeeds, because the step that failed is the one to read. It needs `security-events: write` on the
token and these variables, which GitHub Actions sets: GITHUB_TOKEN (the workflow passes it in `env:`), GITHUB_REPOSITORY,
GITHUB_SHA, GITHUB_REF, and GITHUB_API_URL (optional).
"""

import base64
import gzip
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


def with_category(sarif: dict, category: str) -> dict:
    """Sets the category of every run, as the upload action does (`automationDetails.id` ends with a slash)."""
    for run in sarif.get("runs", []):
        run["automationDetails"] = {"id": f"{category}/"}
    return sarif


def request_body(sarif: dict, commit_sha: str, ref: str) -> bytes:
    packed = base64.b64encode(gzip.compress(json.dumps(sarif).encode("utf-8"))).decode("ascii")
    return json.dumps({"commit_sha": commit_sha, "ref": ref, "sarif": packed}).encode("utf-8")


def upload(path: Path, env: dict[str, str]) -> None:
    sarif = with_category(json.loads(path.read_text(encoding="utf-8")), path.stem)
    url = f"{env.get('GITHUB_API_URL', 'https://api.github.com')}/repos/{env['GITHUB_REPOSITORY']}/code-scanning/sarifs"
    request = urllib.request.Request(
        url,
        data=request_body(sarif, env["GITHUB_SHA"], env["GITHUB_REF"]),
        method="POST",
        headers={
            "Authorization": f"Bearer {env['GITHUB_TOKEN']}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            print(f"uploaded {path.name}: HTTP {response.status}")
    except urllib.error.HTTPError as error:
        raise SystemExit(f"uploading {path.name} failed: HTTP {error.code} {error.read().decode('utf-8', 'replace')[:500]}") from error


def main(argv: list[str]) -> int:
    missing = [name for name in ("GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_REF") if not os.environ.get(name)]
    if missing:
        print(f"missing environment variables: {', '.join(missing)}", file=sys.stderr)
        return 2
    files = [Path(name) for name in argv[1:] if Path(name).is_file()]
    if not files:
        print("no SARIF file to upload (an earlier step stopped before writing one)")
        return 0
    for path in files:
        upload(path, dict(os.environ))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
