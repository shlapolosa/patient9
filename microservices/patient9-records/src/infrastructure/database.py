"""Infrastructure: database engine — constructed FROM Settings (no env access here).

The platform injects DATABASE_URL via envFrom "<database-component>-conn" when
the OAM webservice sets `database: <component-name>`. Works equally with an
in-cluster postgresql component or a BYO secret (e.g. Neon) named the same way.
"""
from typing import Optional

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine

from .config import Settings

_engine: Optional[Engine] = None


def get_engine(settings: Settings) -> Optional[Engine]:
    """Singleton engine; None when no database is bound (in-memory mode)."""
    global _engine
    if not settings.database_url:
        return None
    if _engine is None:
        _engine = create_engine(settings.database_url, pool_pre_ping=True,
                                pool_size=2, max_overflow=2)
    return _engine
