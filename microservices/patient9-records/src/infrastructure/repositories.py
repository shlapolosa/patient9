"""Infrastructure repositories — adapters for the domain ItemRepository port.

SqlItemRepository binds to the platform-injected DATABASE_URL (see
database.py); InMemoryItemRepository keeps the template fully runnable with
no backing services (local dev, unit tests, unbound deployments).
"""
import uuid
from abc import ABC
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import Column, DateTime, MetaData, String, Table, insert, select
from sqlalchemy.engine import Engine

from ..domain.models import Item
from ..domain.repositories import ItemRepository


class Repository(ABC):
    """Base repository interface for dependency injection"""
    pass


class InMemoryItemRepository(ItemRepository):
    def __init__(self):
        self._items: dict[str, Item] = {}

    def add(self, item: Item) -> Item:
        item.id = item.id or str(uuid.uuid4())
        self._items[item.id] = item
        return item

    def get(self, item_id: str) -> Optional[Item]:
        return self._items.get(item_id)

    def list(self) -> List[Item]:
        return list(self._items.values())


_metadata = MetaData()


def _table_name() -> str:
    """Service-scoped table: the platform default is ONE shared database per
    OAM, so sibling services with a fixed "items" table would silently share
    rows (caught patient5, 2026-06-07). K_SERVICE (injected by Knative) scopes
    the table per service; bare "items" remains for local runs/tests."""
    import os
    import re
    svc = os.getenv("K_SERVICE", "")
    return re.sub(r"[^a-zA-Z0-9_]", "_", svc) + "_items" if svc else "items"


_items_table = Table(
    _table_name(), _metadata,
    Column("id", String(36), primary_key=True),
    Column("name", String(255), nullable=False),
    Column("description", String(1024), nullable=False, default=""),
    Column("created_at", DateTime(timezone=True), nullable=False),
)


class SqlItemRepository(ItemRepository):
    def __init__(self, engine: Engine):
        self._engine = engine
        _metadata.create_all(engine)  # idempotent bootstrap; replace with migrations when real

    def add(self, item: Item) -> Item:
        item.id = item.id or str(uuid.uuid4())
        with self._engine.begin() as conn:
            conn.execute(insert(_items_table).values(
                id=item.id, name=item.name, description=item.description,
                created_at=item.created_at,
            ))
        return item

    def get(self, item_id: str) -> Optional[Item]:
        with self._engine.connect() as conn:
            row = conn.execute(
                select(_items_table).where(_items_table.c.id == item_id)
            ).first()
        if row is None:
            return None
        return Item(id=row.id, name=row.name, description=row.description,
                    created_at=row.created_at or datetime.now(timezone.utc))

    def list(self) -> List[Item]:
        with self._engine.connect() as conn:
            rows = conn.execute(select(_items_table)).all()
        return [Item(id=r.id, name=r.name, description=r.description,
                     created_at=r.created_at or datetime.now(timezone.utc)) for r in rows]
