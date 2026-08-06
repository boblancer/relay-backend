"""Add namespaces table and namespace_id/file_url columns to workflows.

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | Sequence[str] | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "namespaces",
        sa.Column("id", sa.Integer(), autoincrement=True, primary_key=True),
        sa.Column("name", sa.Text(), nullable=False, unique=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
    )

    op.add_column(
        "workflows",
        sa.Column(
            "namespace_id",
            sa.Integer(),
            sa.ForeignKey("namespaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
    )
    op.add_column(
        "workflows",
        sa.Column("file_url", sa.Text(), nullable=True),
    )
    op.create_index("ix_workflows_namespace_id", "workflows", ["namespace_id"])


def downgrade() -> None:
    op.drop_index("ix_workflows_namespace_id", table_name="workflows")
    op.drop_column("workflows", "file_url")
    op.drop_column("workflows", "namespace_id")
    op.drop_table("namespaces")
