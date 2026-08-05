from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from scalar_fastapi import AgentScalarConfig, OpenAPISource, get_scalar_api_reference
from starlette.exceptions import HTTPException as StarletteHTTPException

from relay_backend.contract import load_automation_openapi_contract, load_openapi_contract
from relay_backend.controllers.workflows import router as workflow_router
from relay_backend.data.database import Database
from relay_backend.errors import (
    AuthenticationError,
    IdempotencyConflictError,
    PersistenceUnavailableError,
    RevisionConflictError,
    ValidationFailedError,
    WorkflowError,
    WorkflowNotFoundError,
)
from relay_backend.request_limits import RequestBodyLimitMiddleware
from relay_backend.services.workflows import WorkflowService
from relay_backend.settings import Settings

logger = logging.getLogger(__name__)


def create_app(
    *,
    settings: Settings | None = None,
    service: WorkflowService | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        runtime_settings = settings or Settings()
        app.state.settings = runtime_settings
        if service is not None:
            app.state.workflow_service = service
            yield
            return

        database = Database(runtime_settings.database_url)
        database.open()
        app.state.workflow_service = WorkflowService(database)
        try:
            yield
        finally:
            database.close()

    app = FastAPI(
        title="Browser Memory Recorder Cloud Workflow API",
        docs_url=None,
        lifespan=lifespan,
        redoc_url=None,
    )
    contract = load_openapi_contract()
    automation_contract = load_automation_openapi_contract()
    app.openapi = lambda: contract

    @app.get("/docs", include_in_schema=False)
    async def scalar_api_reference():
        return get_scalar_api_reference(
            title="Relay API Reference",
            sources=[
                OpenAPISource(
                    title="Workflow Storage",
                    slug="workflow-storage",
                    content=contract,
                    default=True,
                ),
                OpenAPISource(
                    title="Workflow Runs",
                    slug="workflow-runs",
                    content=automation_contract,
                ),
            ],
            scalar_js_url="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.64.0",
            agent=AgentScalarConfig(disabled=True),
            hide_test_request_button=True,
            persist_auth=False,
            show_developer_tools="never",
            telemetry=False,
        )

    app.add_middleware(RequestBodyLimitMiddleware)
    app.include_router(workflow_router)
    _install_error_handlers(app)
    return app


def _install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(StarletteHTTPException)
    async def framework_http_error(
        request: Request,
        error: StarletteHTTPException,
    ) -> JSONResponse:
        del request
        if error.status_code == 401:
            return _error_response(
                401,
                "unauthorized",
                "Authentication is required.",
                headers={"WWW-Authenticate": "Basic"},
            )
        return JSONResponse(
            status_code=error.status_code,
            content={"detail": error.detail},
            headers=error.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def request_validation_error(
        request: Request,
        error: RequestValidationError,
    ) -> JSONResponse:
        del request, error
        return _error_response(400, "validation_failed", "The workflow request is invalid.")

    @app.exception_handler(WorkflowError)
    async def workflow_error(request: Request, error: WorkflowError) -> JSONResponse:
        del request
        if isinstance(error, AuthenticationError):
            return _error_response(
                401,
                "unauthorized",
                str(error),
                headers={"WWW-Authenticate": "Basic"},
            )
        if isinstance(error, ValidationFailedError):
            return _error_response(400, "validation_failed", str(error))
        if isinstance(error, WorkflowNotFoundError):
            return _error_response(404, "not_found", str(error))
        if isinstance(error, RevisionConflictError):
            return _error_response(409, "revision_conflict", str(error))
        if isinstance(error, IdempotencyConflictError):
            return _error_response(409, "idempotency_conflict", str(error))
        if isinstance(error, PersistenceUnavailableError):
            return _error_response(503, "unavailable", str(error))
        return _error_response(500, "internal", "The workflow storage operation failed.")

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, error: Exception) -> JSONResponse:
        logger.error(
            "Unhandled %s during %s %s",
            type(error).__name__,
            request.method,
            request.url.path,
        )
        return _error_response(500, "internal", "The workflow storage operation failed.")


def _error_response(
    status: int,
    code: str,
    message: str,
    *,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message}},
        headers=headers,
    )


app = create_app()
