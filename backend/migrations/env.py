from logging.config import fileConfig

from alembic import context
from alembic.util import CommandError
from sqlalchemy.exc import OperationalError
from sqlalchemy.pool import NullPool

from app.db import SCHEMA, Base, DatabaseUrlError, create_db_engine, get_database_url

config = context.config

if config.config_file_name is not None:
    # Keep loggers that exist already (pytest's caplog, the app's loggers) working.
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def include_name(name, type_, parent_names):
    # Compare only the app schema; other schemas (public, ops) are never touched.
    if type_ == "schema":
        return name == SCHEMA
    return True


def run_migrations_online() -> None:
    try:
        url = get_database_url()
    except DatabaseUrlError as exc:
        raise CommandError(str(exc)) from None
    # The URL goes straight to the engine, never through alembic.ini (a "%" in a password breaks it).
    engine = create_db_engine(url, poolclass=NullPool)
    try:
        connection = engine.connect()
    except OperationalError as exc:
        # The driver's message is kept (e.g. "authentication failed"); it has no password.
        raise CommandError(f"Could not connect to the database: {exc.orig}") from None
    with connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            include_schemas=True,
            include_name=include_name,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    raise CommandError("Offline (--sql) mode is not supported; run against a database.")
run_migrations_online()
