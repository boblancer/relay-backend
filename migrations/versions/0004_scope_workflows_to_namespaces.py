"""Scope workflows to namespaces.

Revision ID: 0004
Revises: 0003
Create Date: 2026-08-11
"""

from collections.abc import Sequence
from uuid import uuid4

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004"
down_revision: str | Sequence[str] | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NAMESPACE_NAME_CHECK = (
    "char_length(name) BETWEEN 1 AND 100 "
    "AND name = btrim(name) "
    "AND name !~ '^[[:space:]]|[[:space:]]$'"
)


def upgrade() -> None:
    connection = op.get_bind()
    invalid_count = connection.execute(
        sa.text(f"SELECT count(*) FROM namespaces WHERE NOT ({NAMESPACE_NAME_CHECK})")
    ).scalar_one()
    if invalid_count:
        raise RuntimeError("Cannot migrate while namespace names violate the public contract.")

    op.create_check_constraint(
        "ck_namespaces_name",
        "namespaces",
        NAMESPACE_NAME_CHECK,
    )
    op.add_column(
        "workflows",
        sa.Column("namespace_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_workflows_namespace_id_namespaces",
        "workflows",
        "namespaces",
        ["namespace_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    default_namespace_id = connection.execute(
        sa.text("SELECT id FROM namespaces WHERE name = 'Default'")
    ).scalar_one_or_none()
    if default_namespace_id is None:
        default_namespace_id = uuid4()
        connection.execute(
            sa.text("INSERT INTO namespaces (id, name) VALUES (:id, 'Default')"),
            {"id": default_namespace_id},
        )
    connection.execute(
        sa.text("UPDATE workflows SET namespace_id = :id WHERE namespace_id IS NULL"),
        {"id": default_namespace_id},
    )

    op.alter_column(
        "workflows",
        "namespace_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=False,
    )
    op.create_index(
        "ix_workflows_namespace_updated_at",
        "workflows",
        ["namespace_id", sa.text("updated_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_workflows_namespace_updated_at", table_name="workflows")
    op.drop_constraint(
        "fk_workflows_namespace_id_namespaces",
        "workflows",
        type_="foreignkey",
    )
    op.drop_column("workflows", "namespace_id")
    op.drop_constraint("ck_namespaces_name", "namespaces", type_="check")
