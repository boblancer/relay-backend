from __future__ import annotations

import json

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

MAX_REQUEST_BYTES = 1_048_576
TOO_LARGE_BODY = json.dumps(
    {
        "error": {
            "code": "validation_failed",
            "message": "The workflow request must be 1 MiB or smaller.",
        }
    },
    separators=(",", ":"),
).encode()


class RequestBodyLimitMiddleware:
    def __init__(self, app: ASGIApp, maximum_bytes: int = MAX_REQUEST_BYTES) -> None:
        self.app = app
        self.maximum_bytes = maximum_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        content_length = Headers(scope=scope).get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > self.maximum_bytes:
                    await _send_too_large(send)
                    return
            except ValueError:
                pass

        received_bytes = 0

        async def limited_receive() -> Message:
            nonlocal received_bytes
            message = await receive()
            if message["type"] == "http.request":
                received_bytes += len(message.get("body", b""))
                if received_bytes > self.maximum_bytes:
                    raise RequestBodyTooLarge
            return message

        try:
            await self.app(scope, limited_receive, send)
        except RequestBodyTooLarge:
            await _send_too_large(send)


class RequestBodyTooLarge(Exception):
    pass


async def _send_too_large(send: Send) -> None:
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(TOO_LARGE_BODY)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": TOO_LARGE_BODY})
