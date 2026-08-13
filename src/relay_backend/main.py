from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import boto3
import httpx2
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from scalar_fastapi import AgentScalarConfig, OpenAPISource, get_scalar_api_reference
from starlette.exceptions import HTTPException as StarletteHTTPException

from relay_backend.contract import load_automation_openapi_contract, load_openapi_contract
from relay_backend.controllers.namespaces import router as namespace_router
from relay_backend.controllers.runs import router as run_router
from relay_backend.controllers.workflows import router as workflow_router
from relay_backend.data.database import Database
from relay_backend.data.idempotency_repository import IdempotencyRepository
from relay_backend.data.namespace_repository import NamespaceRepository
from relay_backend.document_store import S3WorkflowDocumentStore
from relay_backend.errors import (
    AuthenticationError,
    AutomationUnavailableError,
    IdempotencyConflictError,
    NamespaceConflictError,
    NamespaceNotFoundError,
    PersistenceUnavailableError,
    RevisionConflictError,
    ScopedWorkflowNotFoundError,
    ValidationFailedError,
    WorkflowError,
    WorkflowNotFoundError,
)
from relay_backend.request_limits import RequestBodyLimitMiddleware
from relay_backend.services.namespaces import NamespaceService
from relay_backend.services.workflows import WorkflowService
from relay_backend.settings import Settings

logger = logging.getLogger(__name__)


def _create_document_store(settings: Settings) -> S3WorkflowDocumentStore:
    client = boto3.client(
        "s3",
        endpoint_url=settings.endpoint,
        aws_access_key_id=settings.access_key_id.get_secret_value(),
        aws_secret_access_key=settings.secret_access_key.get_secret_value(),
        region_name=settings.region,
    )
    return S3WorkflowDocumentStore(client, bucket=settings.bucket)


def create_app(
    *,
    settings: Settings | None = None,
    service: WorkflowService | None = None,
    namespace_service: NamespaceService | None = None,
    automation_client: httpx2.AsyncClient | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        runtime_settings = settings or Settings()
        app.state.settings = runtime_settings
        owns_automation_client = automation_client is None
        app.state.automation_client = automation_client or httpx2.AsyncClient(
            follow_redirects=False,
            timeout=httpx2.Timeout(connect=5.0, read=30.0, write=30.0, pool=5.0),
            trust_env=False,
        )
        if service is not None:
            app.state.workflow_service = service
            app.state.namespace_service = namespace_service
            if app.state.namespace_service is None and hasattr(service, "database"):
                app.state.namespace_service = NamespaceService(service.database)
            try:
                yield
            finally:
                if owns_automation_client:
                    await app.state.automation_client.aclose()
            return

        database = Database(runtime_settings.database_url)
        database.open()
        document_store = _create_document_store(runtime_settings)
        namespace_repository = NamespaceRepository()
        idempotency_repository = IdempotencyRepository()
        app.state.workflow_service = WorkflowService(
            database,
            document_store,
            namespace_repository=namespace_repository,
            idempotency_repository=idempotency_repository,
        )
        app.state.namespace_service = NamespaceService(
            database,
            repository=namespace_repository,
            idempotency_repository=idempotency_repository,
        )
        try:
            yield
        finally:
            if owns_automation_client:
                await app.state.automation_client.aclose()
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
    app.include_router(namespace_router)
    app.include_router(workflow_router)
    app.include_router(run_router)
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
        del error
        message = (
            "The namespace request is invalid."
            if request.url.path.startswith("/v1/namespaces")
            and "/workflows" not in request.url.path
            else "The workflow request is invalid."
        )
        return _error_response(400, "validation_failed", message)

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
        if isinstance(error, (NamespaceNotFoundError, ScopedWorkflowNotFoundError)):
            return _error_response(404, "not_found", str(error))
        if isinstance(error, RevisionConflictError):
            return _error_response(409, "revision_conflict", str(error))
        if isinstance(error, IdempotencyConflictError):
            return _error_response(409, "idempotency_conflict", str(error))
        if isinstance(error, NamespaceConflictError):
            return _error_response(409, "namespace_conflict", str(error))
        if isinstance(error, PersistenceUnavailableError):
            return _error_response(503, "unavailable", str(error))
        if isinstance(error, AutomationUnavailableError):
            return _error_response(503, "automation_unavailable", str(error))
        return _error_response(500, "internal", "The workflow storage operation failed.")

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, error: Exception) -> JSONResponse:
        if request.url.path.startswith("/v1/artifacts/"):
            safe_path = "/v1/artifacts/{artifactId}"
        elif request.url.path.startswith("/v1/batches/"):
            safe_path = "/v1/batches/{batchId}"
        else:
            safe_path = request.url.path
        logger.error(
            "Unhandled %s during %s %s",
            type(error).__name__,
            request.method,
            safe_path,
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
