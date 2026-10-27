import pytest
from mcp import Client

import server


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client(tmp_path, monkeypatch):
    # The server opens notes.db in the current folder, so work in a temp one.
    monkeypatch.chdir(tmp_path)
    async with Client(server.mcp) as c:
        yield c
