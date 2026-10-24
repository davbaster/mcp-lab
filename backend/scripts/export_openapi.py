"""Export the API contract to openapi.yaml at the repo root.

Run from backend/:  uv run python scripts/export_openapi.py
Check for drift:    uv run python scripts/export_openapi.py --check

The document is `app.openapi()`, the same data the running app serves at /api/openapi.json.
The script needs no database and no running server. The output is deterministic: dump options
are fixed here, and nothing from the environment goes into the file.
"""

import argparse
import sys
from pathlib import Path
from typing import Any

import yaml
from openapi_spec_validator import validate
from openapi_spec_validator.exceptions import OpenAPIError
from openapi_spec_validator.validation.exceptions import OpenAPIValidationError

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent
DEFAULT_OUTPUT = REPO_ROOT / "openapi.yaml"
OUT_OF_DATE = "openapi.yaml is out of date, run: uv run python scripts/export_openapi.py"

# So that `import app` works however the script is started.
sys.path.insert(0, str(BACKEND_DIR))


class _Dumper(yaml.SafeDumper):
    def ignore_aliases(self, data: Any) -> bool:
        return True  # no &id001 anchors, even when two parts of the spec share an object


def get_document() -> dict[str, Any]:
    from app.main import app

    return app.openapi()


def render(document: dict[str, Any]) -> bytes:
    """The YAML bytes for a document. Every dump option is set here, none is a PyYAML default."""
    text = yaml.dump(
        document,
        Dumper=_Dumper,
        sort_keys=True,
        default_flow_style=False,
        indent=2,
        width=100,
        allow_unicode=True,
        line_break="\n",
    )
    return text.encode("utf-8")


def build() -> bytes:
    """Validate the app's document and return the YAML bytes. Raises on an invalid document."""
    document = get_document()
    validate(document)
    return render(document)


def _shown(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Export the OpenAPI spec to openapi.yaml.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="compare with the committed file instead of writing",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="file to write or check (default: openapi.yaml at the repo root)",
    )
    args = parser.parse_args(argv)

    try:
        content = build()
    except (OpenAPIError, OpenAPIValidationError) as exc:
        print(f"The OpenAPI document is invalid: {exc}", file=sys.stderr)
        return 1

    if args.check:
        if not args.output.is_file() or args.output.read_bytes() != content:
            print(OUT_OF_DATE, file=sys.stderr)
            return 1
        print(f"{_shown(args.output)} is up to date")
        return 0

    args.output.write_bytes(content)
    print(f"Wrote {_shown(args.output)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
