"""Loading the asset maps at startup (#58): every way it can fail, and what a good load holds."""

import json
import os
import sys

import pytest
from sqlalchemy.engine import Engine

from app.assets import FILE_NAME, Asset, _AssetMap, _MapEntry
from app.courses import CourseLoadError, load_catalog
from tests.asset_support import (
    ALPHA,
    BETA,
    BY_EXTENSION,
    DOTTED,
    EMPTY_VTT,
    PNG,
    STRAY,
    SVG,
    file_on_disk,
    map_entries,
    read_map,
    sha256_of,
)
from tests.course_support import FIXTURE_BUILD, GOLDEN_BUILD

BUILD = str(FIXTURE_BUILD)
MAP = "assets-map/alpha-course.json"
VALUE_SENTINEL = "VALUE-SENTINEL-4d2b"  # a value from a broken map that no message may repeat
PIC_ENTRY = "files/png-file.png"
GOOD_HASH = "0123456789abcdef"


def load_error(courses="alpha-course", build=BUILD) -> str:
    with pytest.raises(CourseLoadError) as raised:
        load_catalog(courses, str(build))
    return str(raised.value)


def map_file(build, course="alpha-course"):
    return build / "assets-map" / f"{course}.json"


def write_map(build, document, course="alpha-course"):
    map_file(build, course).write_text(json.dumps(document), encoding="utf-8")


def break_map(build, change, course="alpha-course") -> str:
    """Apply `change(document)` to the alpha map, then return the load error message."""
    document = json.loads(map_file(build, course).read_text(encoding="utf-8"))
    change(document)
    write_map(build, document, course)
    return load_error(course, build)


def good_entry(build, name="x", ext="png", content=b"X"):
    """Write a file into alpha's folder and return a map entry for it."""
    import hashlib

    digest = hashlib.sha256(content).hexdigest()
    file = f"{name}-{digest[:16]}.{ext}"
    file_on_disk(ALPHA, file, build).write_bytes(content)
    return {"file": file, "sha256": digest, "size": len(content)}


# --- the good path ---


def test_each_listed_course_gets_its_assets():
    catalog = load_catalog("alpha-course,beta-course,gamma-course", BUILD)

    alpha = catalog.get(ALPHA).assets
    assert set(alpha) == set(map_entries(ALPHA))
    assert alpha[PNG] == Asset(
        file=PNG,
        content_type="image/png",
        sha256=map_entries(ALPHA)[PNG]["sha256"],
        size=24,
    )
    assert set(catalog.get(BETA).assets) == set(map_entries(BETA))
    assert dict(catalog.get("gamma-course").assets) == {}


def test_the_content_type_of_each_asset_comes_from_the_table_by_extension():
    assets = load_catalog("alpha-course", BUILD).get(ALPHA).assets

    for name, content_type in BY_EXTENSION.values():
        assert assets[name].content_type == content_type


def test_the_assets_are_a_read_only_dictionary_and_an_asset_is_frozen():
    course = load_catalog("alpha-course", BUILD).get(ALPHA)

    with pytest.raises(TypeError):
        course.assets["x"] = None  # type: ignore[index]
    with pytest.raises(AttributeError):
        course.assets[PNG].size = 1  # type: ignore[misc]


def test_two_entries_with_one_file_are_one_name_in_the_dictionary():
    document = read_map(ALPHA)
    sources = [s for s, e in document["files"].items() if e["file"] == PNG]
    assert len(sources) == 2

    assets = load_catalog("alpha-course", BUILD).get(ALPHA).assets

    assert list(assets).count(PNG) == 1
    assert len(assets) == len(document["files"]) - 1


def test_a_course_with_no_assets_loads_with_an_empty_dictionary_and_no_asset_folder(build_copy):
    import shutil

    shutil.rmtree(build_copy / "public" / "assets" / "beta-course")
    write_map(build_copy, {"course_id": "beta-course", "files": {}}, "beta-course")

    catalog = load_catalog("beta-course", str(build_copy))

    assert dict(catalog.get(BETA).assets) == {}


def test_the_bytes_are_not_hashed_at_startup_only_the_size_is_compared(build_copy):
    file_on_disk(ALPHA, PNG, build_copy).write_bytes(b"X" * 24)

    assert load_catalog("alpha-course", str(build_copy)).get(ALPHA).assets[PNG].size == 24


def test_loading_opens_no_database_connection_and_needs_no_database_url(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("loading the assets must not open a database connection")

    monkeypatch.setattr(Engine, "connect", refuse)
    monkeypatch.setattr(Engine, "begin", refuse)
    monkeypatch.delenv("DATABASE_URL", raising=False)

    assert load_catalog("alpha-course,beta-course", BUILD).get(ALPHA).assets


# --- the map file ---


def test_a_missing_map_names_the_course_and_the_path_and_says_how_to_fix_it(build_copy):
    map_file(build_copy).unlink()

    message = load_error("alpha-course", build_copy)

    assert "alpha-course" in message
    assert MAP in message
    assert "make build-content" in message


def test_a_map_that_is_a_folder_fails_like_a_missing_one(build_copy):
    map_file(build_copy).unlink()
    map_file(build_copy).mkdir()

    message = load_error("alpha-course", build_copy)

    assert "alpha-course" in message
    assert MAP in message


def test_a_missing_assets_map_folder_fails(build_copy):
    import shutil

    shutil.rmtree(build_copy / "assets-map")

    assert MAP in load_error("alpha-course", build_copy)


def test_the_map_of_a_second_course_is_checked_too(build_copy):
    map_file(build_copy, "beta-course").unlink()

    message = load_error("alpha-course,beta-course", build_copy)

    assert "assets-map/beta-course.json" in message
    assert "beta-course" in message


@pytest.mark.parametrize(
    "content",
    [b"", b"{ not json", b"\xff\xfe{}", b"\xef\xbb\xbf{}", b"[" * 100000, b"{" * 100000],
)
def test_a_map_that_is_not_utf8_json_fails_naming_the_path(content, build_copy):
    map_file(build_copy).write_bytes(content)

    message = load_error("alpha-course", build_copy)

    assert MAP in message
    assert "alpha-course" in message


@pytest.mark.parametrize("document", [[], "text", 5, None, True, [{"course_id": "alpha-course"}]])
def test_a_map_that_is_not_an_object_fails(document, build_copy):
    write_map(build_copy, document)

    message = load_error("alpha-course", build_copy)

    assert MAP in message
    assert "JSON object" in message


@pytest.mark.parametrize("field", ["course_id", "files"])
def test_a_missing_top_level_field_fails_naming_path_and_field(field, build_copy):
    message = break_map(build_copy, lambda d: d.pop(field))

    assert MAP in message
    assert f"field {field}" in message


@pytest.mark.parametrize("field", ["file", "sha256", "size"])
def test_a_missing_entry_field_fails_naming_path_and_field(field, build_copy):
    message = break_map(build_copy, lambda d: d["files"][PIC_ENTRY].pop(field))

    assert MAP in message
    assert f"files['{PIC_ENTRY}'].{field}" in message


def test_an_unknown_top_level_field_fails_naming_it(build_copy):
    message = break_map(build_copy, lambda d: d.update(schema_version=1))

    assert MAP in message
    assert "field schema_version" in message


def test_an_unknown_entry_field_fails_naming_it(build_copy):
    message = break_map(build_copy, lambda d: d["files"][PIC_ENTRY].update(mime="image/png"))

    assert f"files['{PIC_ENTRY}'].mime" in message


@pytest.mark.parametrize("value", [5, None, ["alpha-course"], {"a": 1}, True])
def test_a_course_id_of_the_wrong_type_fails(value, build_copy):
    message = break_map(build_copy, lambda d: d.update(course_id=value))

    assert "field course_id" in message


@pytest.mark.parametrize("value", [[], "files", 5, None, True, [["a", "b"]]])
def test_a_files_field_that_is_not_an_object_fails(value, build_copy):
    message = break_map(build_copy, lambda d: d.update(files=value))

    assert MAP in message
    assert "field files" in message


@pytest.mark.parametrize("value", [None, "x", 5, ["file"], True])
def test_an_entry_that_is_not_an_object_fails(value, build_copy):
    message = break_map(build_copy, lambda d: d["files"].update({PIC_ENTRY: value}))

    assert f"files['{PIC_ENTRY}']" in message


@pytest.mark.parametrize("field", ["file", "sha256"])
@pytest.mark.parametrize("value", [5, None, True, ["x"], {"a": 1}])
def test_a_string_field_of_the_wrong_type_fails_naming_it(field, value, build_copy):
    message = break_map(build_copy, lambda d: d["files"][PIC_ENTRY].update({field: value}))

    assert f"files['{PIC_ENTRY}'].{field}" in message


def test_a_map_whose_course_id_is_another_course_fails_naming_both(build_copy):
    message = break_map(build_copy, lambda d: d.update(course_id="beta-course"))

    assert MAP in message
    assert "beta-course" in message
    assert "alpha-course" in message


def test_a_map_copied_from_another_course_fails(build_copy):
    map_file(build_copy).write_bytes(map_file(build_copy, "beta-course").read_bytes())

    message = load_error("alpha-course", build_copy)

    assert "beta-course" in message
    assert "alpha-course" in message


# --- the entries ---

BAD_FILE_NAMES = [
    "../x-0123456789abcdef.png",
    "a/b-0123456789abcdef.png",
    "a\\b-0123456789abcdef.png",
    "..",
    "../..",
    "/etc/passwd",
    "/x-0123456789abcdef.png",
    "",
    "-0123456789abcdef.png",
    ".hidden-0123456789abcdef.png",
    ".-0123456789abcdef.png",
    "x.png",
    "x-0123456789abcde.png",  # 15 hex digits
    "x-0123456789abcdef0.png",  # 17 hex digits
    "x-0123456789ABCDEF.png",
    "x-0123456789abcdeg.png",
    "x-0123456789abcdef.PNG",
    "x-0123456789abcdef.Png",
    "x-0123456789abcdef.mp4",
    "x-0123456789abcdef.html",
    "x-0123456789abcdef.exe",
    "x-0123456789abcdef.js",
    "x-0123456789abcdef.png.exe",
    "x-0123456789abcdef.png ",
    " x-0123456789abcdef.png",
    "x-0123456789abcdef.png\n",
    "x-0123456789abcdef",
    "x-0123456789abcdef.",
    "x 0-0123456789abcdef.png",
    "é-0123456789abcdef.png",
    "x-0123456789abcdef.png\x00",
    "x-0123456789abcdef.png/",
    "C:x-0123456789abcdef.png",
]


@pytest.mark.parametrize("name", BAD_FILE_NAMES)
def test_a_bad_file_name_fails_naming_the_field_and_not_the_value(name, build_copy):
    def change(document):
        document["files"][PIC_ENTRY]["file"] = name

    message = break_map(build_copy, change)

    assert MAP in message
    assert f"files['{PIC_ENTRY}'].file" in message
    assert name == "" or name not in message


@pytest.mark.parametrize(
    "name",
    [
        "x-0123456789abcdef.png",
        "X-0123456789abcdef.png",
        "my.file-0123456789abcdef.png",
        "_x-0123456789abcdef.jpeg",
        "1-0123456789abcdef.svg",
        "a-b-c-0123456789abcdef.vtt",
        "a--0123456789abcdef.glb",
        "x-0123456789abcdef.gltf",
        "x-0123456789abcdef.webp",
        "x-0123456789abcdef.jpg",
        "x.-0123456789abcdef.png",
    ],
)
def test_the_file_pattern_accepts_the_names_the_build_writes(name):
    assert FILE_NAME.fullmatch(name)


@pytest.mark.parametrize("name", BAD_FILE_NAMES)
def test_the_file_pattern_rejects_every_bad_name(name):
    assert FILE_NAME.fullmatch(name) is None


@pytest.mark.parametrize(
    "value",
    [
        "",
        "abc",
        "A" * 64,
        "g" * 64,
        "0" * 63,
        "0" * 65,
        ("0" * 63) + "A",
        " " + "0" * 63,
        ("0" * 64) + "\n",
        "sha256:" + "0" * 57,
    ],
)
def test_a_sha256_that_is_not_64_lowercase_hex_digits_fails_naming_the_field(value, build_copy):
    message = break_map(build_copy, lambda d: d["files"][PIC_ENTRY].update(sha256=value))

    assert f"files['{PIC_ENTRY}'].sha256" in message


@pytest.mark.parametrize("value", [-1, 1.5, 24.0, "24", True, False, None, [24], 10**30 * -1])
def test_a_size_that_is_not_a_non_negative_integer_fails_naming_the_field(value, build_copy):
    message = break_map(build_copy, lambda d: d["files"][PIC_ENTRY].update(size=value))

    assert f"files['{PIC_ENTRY}'].size" in message


def test_two_entries_with_the_same_file_and_the_same_hash_and_size_are_accepted(build_copy):
    entry = dict(read_map(ALPHA)["files"][PIC_ENTRY])

    def change(document):
        document["files"]["another/path.png"] = dict(entry)

    document = json.loads(map_file(build_copy).read_text(encoding="utf-8"))
    change(document)
    write_map(build_copy, document)

    assert load_catalog("alpha-course", str(build_copy)).get(ALPHA).assets[PNG].file == PNG


@pytest.mark.parametrize(
    "change",
    [{"sha256": "f" * 64}, {"size": 25}],
    ids=["other sha256", "other size"],
)
def test_two_entries_with_the_same_file_and_other_data_fail(change, build_copy):
    def edit(document):
        entry = dict(document["files"][PIC_ENTRY])
        entry.update(change)
        document["files"]["zzz/other.png"] = entry

    message = break_map(build_copy, edit)

    assert MAP in message
    assert "another entry" in message
    assert "zzz/other.png" in message


@pytest.mark.parametrize("value", [VALUE_SENTINEL, "../" + VALUE_SENTINEL, VALUE_SENTINEL * 100])
@pytest.mark.parametrize("field", ["file", "sha256"])
def test_a_message_never_repeats_a_value_of_the_map(field, value, build_copy):
    def change(document):
        document["files"][PIC_ENTRY][field] = value

    assert VALUE_SENTINEL not in break_map(build_copy, change)


@pytest.mark.parametrize("field", ["size", "file", "sha256"])
def test_a_message_never_repeats_a_value_of_the_wrong_type(field, build_copy):
    message = break_map(
        build_copy, lambda d: d["files"][PIC_ENTRY].update({field: [VALUE_SENTINEL]})
    )

    assert VALUE_SENTINEL not in message


def test_a_message_never_repeats_the_content_of_a_map_that_is_not_json(build_copy):
    map_file(build_copy).write_text("{ " + VALUE_SENTINEL, encoding="utf-8")

    assert VALUE_SENTINEL not in load_error("alpha-course", build_copy)


def test_a_very_long_course_id_in_the_map_is_not_repeated(build_copy):
    message = break_map(build_copy, lambda d: d.update(course_id="x" * 5000))

    assert "x" * 1000 not in message


# --- the files on disk ---


def test_a_listed_file_that_does_not_exist_fails_naming_the_path(build_copy):
    file_on_disk(ALPHA, PNG, build_copy).unlink()

    message = load_error("alpha-course", build_copy)

    assert f"public/assets/alpha-course/{PNG}" in message
    assert "alpha-course" in message
    assert str(build_copy) not in message


def test_a_listed_file_that_is_a_folder_fails(build_copy):
    path = file_on_disk(ALPHA, SVG, build_copy)
    path.unlink()
    path.mkdir()

    message = load_error("alpha-course", build_copy)

    assert f"public/assets/alpha-course/{SVG}" in message


def test_a_missing_asset_folder_fails_when_the_map_lists_a_file(build_copy):
    import shutil

    shutil.rmtree(build_copy / "public" / "assets" / "alpha-course")

    assert "public/assets/alpha-course/" in load_error("alpha-course", build_copy)


def test_a_file_of_another_course_does_not_stand_in(build_copy):
    # The name is in beta's folder only: alpha's map lists it, alpha's folder does not have it.
    beta_only = next(iter(set(map_entries(BETA)) - set(map_entries(ALPHA))))

    def change(document):
        document["files"]["x/y.png"] = map_entries(BETA)[beta_only]

    message = break_map(build_copy, change)

    assert f"public/assets/alpha-course/{beta_only}" in message


@pytest.mark.skipif(
    sys.platform == "win32",
    reason="creating a symbolic link on Windows needs a privilege the CI job may not have",
)
def test_a_listed_file_that_is_a_symbolic_link_fails(build_copy):
    path = file_on_disk(ALPHA, PNG, build_copy)
    target = build_copy / "elsewhere.png"
    target.write_bytes(path.read_bytes())
    path.unlink()
    os.symlink(target, path)

    message = load_error("alpha-course", build_copy)

    assert f"public/assets/alpha-course/{PNG}" in message
    assert "symbolic link" in message


@pytest.mark.skipif(sys.platform == "win32", reason="same as the link test above")
def test_a_listed_file_that_is_a_link_to_a_file_outside_the_build_fails(build_copy, tmp_path):
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"OUTSIDE-SENTINEL-the-build-folder")
    path = file_on_disk(ALPHA, EMPTY_VTT, build_copy)
    path.unlink()
    os.symlink(outside, path)

    message = load_error("alpha-course", build_copy)

    assert EMPTY_VTT in message
    assert "OUTSIDE-SENTINEL" not in message


def test_a_size_on_disk_that_differs_from_the_map_fails_naming_the_file(build_copy):
    file_on_disk(ALPHA, PNG, build_copy).write_bytes(b"too short")

    message = load_error("alpha-course", build_copy)

    assert f"public/assets/alpha-course/{PNG}" in message
    assert "24" in message
    assert "9" in message


def test_a_listed_file_that_is_empty_but_listed_with_a_size_fails(build_copy):
    file_on_disk(ALPHA, PNG, build_copy).write_bytes(b"")

    assert PNG in load_error("alpha-course", build_copy)


def test_a_stray_file_in_the_folder_is_not_an_error(build_copy):
    assert file_on_disk(ALPHA, STRAY, build_copy).is_file()

    assert STRAY not in load_catalog("alpha-course", str(build_copy)).get(ALPHA).assets


# --- only the listed courses are read ---


def test_a_course_outside_courses_is_not_read_even_when_its_map_and_files_are_broken(build_copy):
    map_file(build_copy, "unlisted-course").write_bytes(b"{ broken")
    for path in (build_copy / "public" / "assets" / "unlisted-course").iterdir():
        path.unlink()

    catalog = load_catalog("alpha-course,beta-course", str(build_copy))

    assert "unlisted-course" not in catalog


@pytest.mark.parametrize("kind", ["missing", "empty", "folder"])
def test_a_course_outside_courses_may_have_no_usable_map(kind, build_copy):
    path = map_file(build_copy, "unlisted-course")
    path.unlink()
    if kind == "empty":
        path.write_bytes(b"")
    elif kind == "folder":
        path.mkdir()

    assert load_catalog("alpha-course", str(build_copy)).get("unlisted-course") is None


def test_a_broken_map_of_a_course_that_is_listed_but_comes_second_still_stops_startup(build_copy):
    map_file(build_copy, "beta-course").write_text("[]", encoding="utf-8")

    assert "beta-course" in load_error("alpha-course,beta-course", build_copy)


# --- the fixture and the real build output ---


def test_the_fixture_maps_are_honest_about_hash_and_size():
    for course in ("alpha-course", "beta-course", "unlisted-course"):
        for name, entry in map_entries(course).items():
            path = file_on_disk(course, name)
            assert sha256_of(path) == entry["sha256"], name
            assert path.stat().st_size == entry["size"], name
            if (course, name) != (BETA, PNG):  # beta's file borrows alpha's name on purpose
                assert name.split("-")[-1].split(".")[0] == entry["sha256"][:16], name


def test_the_fixture_build_has_exactly_the_asset_files_the_tests_know_about():
    on_disk = sorted(
        str(path.relative_to(FIXTURE_BUILD / "public"))
        for path in (FIXTURE_BUILD / "public").rglob("*")
        if path.is_file()
    )
    maps = sorted(path.name for path in (FIXTURE_BUILD / "assets-map").iterdir())

    assert len(on_disk) == 12 + 2 + 1  # alpha (with the stray file), beta, unlisted
    assert on_disk.count(f"assets/alpha-course/{STRAY}") == 1
    assert f"assets/alpha-course/{DOTTED}" in on_disk
    assert maps == [
        "alpha-course.json",
        "beta-course.json",
        "delta-course.json",
        "epsilon-course.json",
        "gamma-course.json",
        "unlisted-course.json",
    ]


def test_every_asset_file_of_the_fixture_holds_a_sentinel():
    for path in (FIXTURE_BUILD / "public").rglob("*"):
        if path.is_file() and path.stat().st_size > 0:
            assert b"ASSET-SENTINEL" in path.read_bytes(), path.name


def test_the_golden_map_of_the_content_build_is_accepted():
    catalog = load_catalog("sample-course", str(GOLDEN_BUILD))

    golden = json.loads((GOLDEN_BUILD / "assets-map" / "sample-course.json").read_text())
    assets = catalog.get("sample-course").assets
    assert {a.file for a in assets.values()} == {e["file"] for e in golden["files"].values()}
    for entry in golden["files"].values():
        asset = assets[entry["file"]]
        assert (asset.sha256, asset.size) == (entry["sha256"], entry["size"])
        assert asset.content_type


def test_the_keys_of_the_golden_map_are_the_keys_the_loader_accepts():
    # A change in what the build writes fails here, in the backend suite, and not at deploy time.
    golden = json.loads((GOLDEN_BUILD / "assets-map" / "sample-course.json").read_text())

    assert set(golden) == set(_AssetMap.model_fields)
    for entry in golden["files"].values():
        assert set(entry) == set(_MapEntry.model_fields)


def test_every_name_in_the_golden_map_matches_the_file_pattern():
    golden = json.loads((GOLDEN_BUILD / "assets-map" / "sample-course.json").read_text())

    for entry in golden["files"].values():
        assert FILE_NAME.fullmatch(entry["file"]), entry["file"]
