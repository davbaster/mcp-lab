import json

import pytest

pytestmark = pytest.mark.anyio


async def test_get_note_rejects_id_zero(client):
    result = await client.call_tool("get_note", {"note_id": 0})
    assert result.is_error
    assert "positive integer" in result.content[0].text


@pytest.fixture
def outside(tmp_path):
    return tmp_path / "outside.json"


@pytest.mark.parametrize("tool", ["export_notes", "import_notes"])
async def test_parent_folder_is_rejected(client, tool):
    result = await client.call_tool(tool, {"path": "../x.json"})
    assert result.is_error
    assert "inside the data folder" in result.content[0].text


@pytest.mark.parametrize("tool", ["export_notes", "import_notes"])
async def test_absolute_path_is_rejected(client, tool, outside):
    result = await client.call_tool(tool, {"path": str(outside)})
    assert result.is_error
    assert "inside the data folder" in result.content[0].text
    assert not outside.exists()


@pytest.mark.parametrize("tool", ["export_notes", "import_notes"])
async def test_symlink_out_of_the_folder_is_rejected(client, tool, tmp_path):
    (tmp_path / "elsewhere").mkdir()
    try:
        (tmp_path / "data" / "link").symlink_to(tmp_path / "elsewhere")
    except OSError:
        pytest.skip("symlinks are not available here")
    result = await client.call_tool(tool, {"path": "link/x.json"})
    assert result.is_error
    assert "inside the data folder" in result.content[0].text


async def test_export_then_import_round_trip(client, tmp_path):
    await client.call_tool("create_note", {"title": "Milk", "body": "Buy milk"})
    exported = await client.call_tool("export_notes", {"path": "backup.json"})
    assert exported.content[0].text == "Exported to backup.json"
    assert json.loads((tmp_path / "data" / "backup.json").read_text())[0]["title"] == "Milk"
    await client.call_tool("import_notes", {"path": "backup.json"})
    notes = (await client.call_tool("list_notes", {})).structured_content["result"]
    assert [n["title"] for n in notes] == ["Milk", "Milk"]
