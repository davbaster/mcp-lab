from mcp.server.mcpserver import MCPServer

mcp = MCPServer("notes")


@mcp.tool()
def add(a: int, b: int) -> int:
    return a + b


if __name__ == "__main__":
    mcp.run()
