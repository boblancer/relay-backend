from __future__ import annotations


class WorkflowError(Exception):
    """Base class for safe, contract-facing failures."""


class AuthenticationError(WorkflowError):
    def __init__(self) -> None:
        super().__init__("Authentication is required.")


class ValidationFailedError(WorkflowError):
    def __init__(self, message: str = "The workflow request is invalid.") -> None:
        super().__init__(message)


class WorkflowNotFoundError(WorkflowError):
    def __init__(self) -> None:
        super().__init__("The workflow was not found.")


class NamespaceNotFoundError(WorkflowError):
    def __init__(self) -> None:
        super().__init__("The namespace was not found.")


class ScopedWorkflowNotFoundError(WorkflowError):
    def __init__(self) -> None:
        super().__init__("The namespace or workflow was not found.")


class NamespaceConflictError(WorkflowError):
    def __init__(self) -> None:
        super().__init__("A namespace with that name already exists.")


class RevisionConflictError(WorkflowError):
    def __init__(self) -> None:
        super().__init__("The workflow changed since it was loaded.")


class IdempotencyConflictError(WorkflowError):
    def __init__(self) -> None:
        super().__init__("The idempotency key was already used for another request.")


class PersistenceUnavailableError(WorkflowError):
    def __init__(self) -> None:
        super().__init__("Workflow storage is temporarily unavailable.")


class AutomationUnavailableError(WorkflowError):
    def __init__(self) -> None:
        super().__init__("The automation service is unavailable.")


class InternalPersistenceError(WorkflowError):
    def __init__(self) -> None:
        super().__init__("The workflow storage operation failed.")
