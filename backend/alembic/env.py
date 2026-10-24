from alembic import context
from sqlalchemy import engine_from_config, pool
import os
config = context.config
config.set_main_option('sqlalchemy.url', os.environ['DATABASE_URL'].replace('postgresql://', 'postgresql+psycopg://', 1))
if context.is_offline_mode():
    context.configure(url=os.environ['DATABASE_URL'], literal_binds=True)
    with context.begin_transaction(): context.run_migrations()
else:
    connectable = engine_from_config(config.get_section(config.config_ini_section), prefix='sqlalchemy.', poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection)
        with context.begin_transaction(): context.run_migrations()
