"""Add object-store keys for canonical workflow documents.

Revision ID: 0003
Revises: 0002
Create Date: 2026-08-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: str | Sequence[str] | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("workflows", sa.Column("document_key", sa.Text(), nullable=True))
    op.alter_column(
        "workflows",
        "document",
        existing_type=postgresql.JSONB(),
        nullable=True,
    )
    op.create_check_constraint(
        "ck_workflows_document_location",
        "workflows",
        "document IS NOT NULL OR document_key IS NOT NULL",
    )


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM workflows WHERE document IS NULL) THEN
                RAISE EXCEPTION
                    'Cannot downgrade while workflows depend on object-store documents';
            END IF;
        END
        $$
        """
    )
    op.drop_constraint("ck_workflows_document_location", "workflows", type_="check")
    op.drop_column("workflows", "document_key")
    op.alter_column(
        "workflows",
        "document",
        existing_type=postgresql.JSONB(),
        nullable=False,
    )
