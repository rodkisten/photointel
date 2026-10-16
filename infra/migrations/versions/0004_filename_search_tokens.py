"""Index filename words separately from PostgreSQL file/host parser tokens.

Revision ID: 0004_filename_search_tokens
Revises: 0003_bridge_inventory_indexes
"""

from alembic import op

revision = "0004_filename_search_tokens"
down_revision = "0003_bridge_inventory_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The standard parser treats garden.jpg and some hyphenated filenames as
    # indivisible file/host tokens. Preserve them and also index their words.
    op.execute("""
        CREATE FUNCTION photointel_filename_document(photo_filename text)
        RETURNS tsvector LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
            SELECT to_tsvector('simple', coalesce(photo_filename, '')) ||
                to_tsvector('simple', regexp_replace(
                    coalesce(photo_filename, ''), '[^[:alnum:]]+', ' ', 'g'
                ))
        $$
    """)
    op.execute("""
        CREATE OR REPLACE FUNCTION photointel_asset_search_document() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            NEW.search_document := photointel_filename_document(NEW.filename);
            RETURN NEW;
        END
        $$
    """)
    # Preserve existing accepted tag terms. This migration only adds filename
    # words; visibility changes continue rebuilding the document in the API.
    op.execute("""
        UPDATE assets SET search_document =
            coalesce(search_document, ''::tsvector) ||
            photointel_filename_document(filename)
    """)


def downgrade() -> None:
    op.execute("""
        CREATE OR REPLACE FUNCTION photointel_asset_search_document() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            NEW.search_document := to_tsvector('simple', coalesce(NEW.filename, ''));
            RETURN NEW;
        END
        $$
    """)
    op.execute("DROP FUNCTION photointel_filename_document(text)")
