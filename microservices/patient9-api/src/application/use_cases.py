"""Application use cases following CLAUDE.md principles.

Use cases depend on domain PORTS (ItemRepository, Cache) injected by the
interface layer — never on concrete infrastructure.
"""
import json
from abc import ABC, abstractmethod
from typing import Generic, List, Optional, TypeVar

from ..domain.models import Item
from ..domain.repositories import Cache, ItemRepository

T = TypeVar('T')


class UseCase(ABC, Generic[T]):
    """Base use case following CLAUDE.md patterns"""

    @abstractmethod
    async def execute(self, request: T) -> dict:
        pass


class CreateItem:
    def __init__(self, repo: ItemRepository, cache: Cache):
        self._repo = repo
        self._cache = cache

    def execute(self, name: str, description: str = "") -> Item:
        item = self._repo.add(Item(name=name, description=description))
        self._cache.set(f"item:{item.id}", item.model_dump_json())
        self._cache.delete("items:all")  # list view changed
        return item


class GetItem:
    """Cache-aside read: cache hit -> domain object; miss -> repo + populate."""

    def __init__(self, repo: ItemRepository, cache: Cache):
        self._repo = repo
        self._cache = cache

    def execute(self, item_id: str) -> Optional[Item]:
        cached = self._cache.get(f"item:{item_id}")
        if cached:
            return Item(**json.loads(cached))
        item = self._repo.get(item_id)
        if item:
            self._cache.set(f"item:{item.id}", item.model_dump_json())
        return item


class ListItems:
    """Cache-aside list (GETs are cached by default; short TTL + eviction on write)."""

    def __init__(self, repo: ItemRepository, cache: Cache):
        self._repo = repo
        self._cache = cache

    def execute(self) -> List[Item]:
        cached = self._cache.get("items:all")
        if cached:
            return [Item(**i) for i in json.loads(cached)]
        items = self._repo.list()
        self._cache.set("items:all", json.dumps([json.loads(i.model_dump_json()) for i in items]), ttl_seconds=60)
        return items
