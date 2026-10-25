"""The ID of the request being handled, for the log lines written while handling it.

The request middleware sets it at the start of each request. A context variable follows the
request into the thread pool that runs sync routes (the server copies the context), so one ID
finds every record of a request. Outside a request it is `None`, and records carry no
`request_id` key. Each request runs in its own task, so the value does not outlive it.
"""

from contextvars import ContextVar

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
