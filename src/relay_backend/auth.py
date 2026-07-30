from __future__ import annotations

import secrets
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from relay_backend.errors import AuthenticationError

basic_auth = HTTPBasic(auto_error=False)


def require_basic_auth(
    request: Request,
    credentials: Annotated[HTTPBasicCredentials | None, Depends(basic_auth)],
) -> None:
    if credentials is None:
        raise AuthenticationError

    settings = request.app.state.settings
    username_matches = secrets.compare_digest(
        credentials.username.encode(),
        settings.basic_auth_username.encode(),
    )
    password_matches = secrets.compare_digest(
        credentials.password.encode(),
        settings.basic_auth_password.get_secret_value().encode(),
    )
    if not (username_matches and password_matches):
        raise AuthenticationError
