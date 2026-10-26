import pytest
from mcp import Client

import server


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NOTES_DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("NOTES_DATA_DIR", str(tmp_path / "data"))
    async with Client(server.mcp) as c:
        yield c
