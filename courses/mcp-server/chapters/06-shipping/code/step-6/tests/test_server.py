import json

import pytest
from mcp.shared.exceptions import MCPError

pytestmark = pytest.mark.anyio


async def test_lists_the_tools(client):
    result = await client.list_tools()
    assert {t.name for t in result.tools} == {
        "create_note", "list_notes", "get_note",
        "update_note", "delete_note", "import_notes", "export_notes",
    }


async def test_annotations(client):
    tools = {t.name: t for t in (await client.list_tools()).tools}
    assert tools["list_notes"].annotations.read_only_hint is True
    assert tools["delete_note"].annotations.destructive_hint is True


async def test_create_and_list(client):
    created = await client.call_tool("create_note", {"title": "Milk", "body": "Buy milk"})
    assert created.structured_content["id"] == 1
    listed = await client.call_tool("list_notes", {})
    assert listed.structured_content["result"][0]["title"] == "Milk"


async def test_get_update_delete(client):
    await client.call_tool("create_note", {"title": "Milk", "body": "Buy milk"})
    got = await client.call_tool("get_note", {"note_id": 1})
    assert got.structured_content["body"] == "Buy milk"
    updated = await client.call_tool("update_note", {"note_id": 1, "title": "Oat milk"})
    assert updated.structured_content["title"] == "Oat milk"
    deleted = await client.call_tool("delete_note", {"note_id": 1})
    assert not deleted.is_error


@pytest.mark.parametrize(
    "tool, arguments",
    [
        ("get_note", {"note_id": 99}),
        ("update_note", {"note_id": 99, "title": "x"}),
        ("delete_note", {"note_id": 99}),
    ],
)
async def test_missing_note_is_an_error_result(client, tool, arguments):
    result = await client.call_tool(tool, arguments)
    assert result.is_error
    assert "not found" in result.content[0].text


async def test_import_notes(client, tmp_path):
    source = tmp_path / "data" / "in.json"
    source.write_text(json.dumps([{"title": "a", "body": "b"}]))
    result = await client.call_tool("import_notes", {"path": "in.json"})
    assert result.content[0].text == "Imported 1 notes"
    assert len((await client.call_tool("list_notes", {})).structured_content["result"]) == 1


async def test_index_resource(client):
    await client.call_tool("create_note", {"title": "Milk", "body": "Buy milk"})
    result = await client.read_resource("notes://index")
    assert json.loads(result.contents[0].text) == [{"id": 1, "title": "Milk"}]


async def test_missing_resource_raises(client):
    with pytest.raises(MCPError):
        await client.read_resource("notes://77")
