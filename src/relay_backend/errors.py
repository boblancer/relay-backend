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


class RevisionConflictError(WorkflowError):
    def __init__(self) -> None:
        super().__init__("The workflow changed since it was loaded.")


class IdempotencyConflictError(WorkflowError):
    def __init__(self) -> None:
        super().__init__("The idempotency key was already used for another request.")


class PersistenceUnavailableError(WorkflowError):
    def __init__(self) -> None:
        super().__init__("Workflow storage is temporarily unavailable.")


class InternalPersistenceError(WorkflowError):
    def __init__(self) -> None:
        super().__init__("The workflow storage operation failed.")


class RequestTooLargeError(WorkflowError):
    def __init__(self) -> None:
        super().__init__("The workflow request must be 1 MiB or smaller.")
