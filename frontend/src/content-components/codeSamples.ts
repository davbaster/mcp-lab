/** One sample file for each language the viewer highlights: non-ASCII text, a tab, and a final newline. */
export const SAMPLES = {
  "sample.py": `import os
from typing import Optional

CONSTANT = 42  # número – ünï

@decorator
class Server(Base):
\tdef handle(self, request: str, retries: int = 3) -> Optional[str]:
\t\t"""Docstring with é."""
\t\tname = f"hello {request}"
\t\tif retries > 0 and name:
\t\t\treturn name.upper()
\t\treturn None
`,
  "sample.toml": `# café
[project]
name = "mcp-lab"
version = "0.1.0"
tags = ["a", "b"]
enabled = true
count = 3

[[tool.items]]
key = 'single'
`,
  "sample.json": `{
  "name": "mcp-lab",
\t"número": [1, 2.5, true, null],
  "nested": { "key": "värde" }
}
`,
  "sample.yaml": `# comment ü
name: mcp-lab
items:
  - one
  - "two"
nested: { a: 1 }
note: "a\tb"
count: 3
enabled: true
`,
  "sample.md": `# Título

Some *emphasis* and **strong** text with \`code\` and a [link](https://example.com).

- item one
\t- item two

\`\`\`python
print("hi")
\`\`\`
`,
  "sample.sh": `#!/usr/bin/env bash
# comentário
set -euo pipefail
NAME="mundo"
if [ -n "$NAME" ]; then
\techo "hola $NAME" | tr a-z A-Z
fi
`,
} as const;
