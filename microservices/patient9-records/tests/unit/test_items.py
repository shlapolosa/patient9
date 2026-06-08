"""Unit tests for the Item vertical slice (in-memory adapters — no backing services)."""
from src.application.use_cases import CreateItem, GetItem, ListItems
from src.infrastructure.cache import NullCache
from src.infrastructure.repositories import InMemoryItemRepository


def _wired(cache=None):
    repo, cache = InMemoryItemRepository(), cache or NullCache()
    return CreateItem(repo, cache), GetItem(repo, cache), ListItems(repo, cache)


def test_create_assigns_id():
    create, _, _ = _wired()
    item = create.execute(name="widget", description="a widget")
    assert item.id and item.name == "widget"


def test_get_roundtrip():
    create, get, _ = _wired()
    item = create.execute(name="widget")
    assert get.execute(item.id).name == "widget"


def test_get_missing_returns_none():
    _, get, _ = _wired()
    assert get.execute("nope") is None


def test_list_returns_all():
    create, _, list_items = _wired()
    create.execute(name="a"); create.execute(name="b")
    assert {i.name for i in list_items.execute()} == {"a", "b"}


class DictCache:
    """Real-ish cache double proving cache-aside + eviction semantics."""
    def __init__(self): self.d = {}
    def get(self, key): return self.d.get(key)
    def set(self, key, value, ttl_seconds=300): self.d[key] = value
    def delete(self, key): self.d.pop(key, None)


def test_list_is_cached_and_evicted_on_create():
    cache = DictCache()
    create, _, list_items = _wired(cache)
    create.execute(name="a")
    assert len(list_items.execute()) == 1
    assert "items:all" in cache.d            # GET populated the cache
    create.execute(name="b")
    assert "items:all" not in cache.d        # write evicted it
    assert len(list_items.execute()) == 2    # repopulated fresh
