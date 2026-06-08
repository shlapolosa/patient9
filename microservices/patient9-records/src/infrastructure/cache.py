"""Infrastructure: cache adapter from the platform binding contract.

REDIS_URL/CACHE_URL arrive via envFrom "<cache-component>-conn" when the OAM
webservice sets `cache: <component-name>`. Falls back to a no-op cache when
unbound — the service runs identically without a cache component.
"""
from typing import Optional

from ..domain.repositories import Cache
from .config import Settings


class NullCache(Cache):
    def get(self, key: str) -> Optional[str]:
        return None

    def set(self, key: str, value: str, ttl_seconds: int = 300) -> None:
        return None

    def delete(self, key: str) -> None:
        return None


class RedisCache(Cache):
    """Keys are prefixed with the service name: the platform default is ONE
    shared redis per OAM (frugality), so unprefixed keys from sibling services
    sharing the cache would collide (caught: patient5-api vs patient5-records
    both writing items:* keys, 2026-06-07). Prefixing in the adapter keeps the
    use cases collision-free without knowing about sharing."""

    def __init__(self, url: str, key_prefix: str = ""):
        import redis  # lazy: only needed when a cache is actually bound
        self._r = redis.Redis.from_url(url, socket_timeout=2, socket_connect_timeout=2)
        self._prefix = f"{key_prefix}:" if key_prefix else ""

    def _k(self, key: str) -> str:
        return self._prefix + key

    def get(self, key: str) -> Optional[str]:
        try:
            v = self._r.get(self._k(key))
            return v.decode() if v is not None else None
        except Exception:
            return None  # cache-aside: failures degrade to a miss, never an error

    def set(self, key: str, value: str, ttl_seconds: int = 300) -> None:
        try:
            self._r.setex(self._k(key), ttl_seconds, value)
        except Exception:
            pass

    def delete(self, key: str) -> None:
        try:
            self._r.delete(self._k(key))
        except Exception:
            pass


def get_cache(settings: Settings) -> Cache:
    url = settings.redis_url
    if url:
        try:
            return RedisCache(url, key_prefix=settings.service_name)
        except Exception:
            return NullCache()
    return NullCache()
