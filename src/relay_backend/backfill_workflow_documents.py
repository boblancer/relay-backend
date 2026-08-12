from __future__ import annotations

import argparse
import logging
from dataclasses import dataclass

import boto3

from relay_backend.data.database import Database
from relay_backend.data.workflow_repository import WorkflowRepository
from relay_backend.document_store import S3WorkflowDocumentStore, WorkflowDocumentStore
from relay_backend.settings import Settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class BackfillResult:
    migrated: int
    skipped: int


def backfill_workflow_documents(
    database: Database,
    document_store: WorkflowDocumentStore,
    *,
    batch_size: int = 100,
    repository: WorkflowRepository | None = None,
) -> BackfillResult:
    if batch_size < 1:
        raise ValueError("batch_size must be positive")
    repository = repository or WorkflowRepository()
    migrated = 0
    skipped = 0

    while True:
        with database.transaction() as connection:
            batch = repository.list_legacy_documents(connection, limit=batch_size)
        if not batch:
            return BackfillResult(migrated=migrated, skipped=skipped)

        for legacy in batch:
            object_key = document_store.put(legacy.workflow)
            with database.transaction() as connection:
                published = repository.publish_backfilled_document(
                    connection,
                    workflow_id=legacy.workflow.id,
                    revision=legacy.revision,
                    document_key=object_key,
                )
            if published:
                migrated += 1
            else:
                skipped += 1


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Backfill workflow documents to object storage")
    parser.add_argument("--batch-size", type=int, default=100)
    args = parser.parse_args()
    database = None
    try:
        settings = Settings()
        database = Database(settings.database_url)
        client = boto3.client(
            "s3",
            endpoint_url=settings.endpoint,
            aws_access_key_id=settings.access_key_id.get_secret_value(),
            aws_secret_access_key=settings.secret_access_key.get_secret_value(),
            region_name=settings.region,
        )
        document_store = S3WorkflowDocumentStore(client, bucket=settings.bucket)
        database.open()
        result = backfill_workflow_documents(
            database,
            document_store,
            batch_size=args.batch_size,
        )
    except Exception as error:
        logger.error("Workflow document backfill failed with %s", type(error).__name__)
        raise SystemExit(1) from None
    finally:
        if database is not None:
            try:
                database.close()
            except Exception as error:
                logger.error(
                    "Workflow document backfill cleanup failed with %s",
                    type(error).__name__,
                )
                raise SystemExit(1) from None
    logger.info(
        "Workflow document backfill completed: migrated=%d skipped=%d",
        result.migrated,
        result.skipped,
    )


if __name__ == "__main__":
    main()
