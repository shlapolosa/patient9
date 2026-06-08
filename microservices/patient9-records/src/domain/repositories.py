"""Domain ports (repository interfaces) — Onion Architecture.

The domain owns the interface; infrastructure provides the adapter
(SQL via the platform binding contract, in-memory for local dev/tests).
"""
from abc import ABC, abstractmethod
from typing import List, Optional

from .models import Item


class ItemRepository(ABC):
    """Port for Item persistence."""

    @abstractmethod
    def add(self, item: Item) -> Item: ...

    @abstractmethod
    def get(self, item_id: str) -> Optional[Item]: ...

    @abstractmethod
    def list(self) -> List[Item]: ...


class Cache(ABC):
    """Port for cache-aside reads (platform binding: REDIS_URL/CACHE_URL)."""

    @abstractmethod
    def get(self, key: str) -> Optional[str]: ...

    @abstractmethod
    def set(self, key: str, value: str, ttl_seconds: int = 300) -> None: ...

    @abstractmethod
    def delete(self, key: str) -> None: ...
