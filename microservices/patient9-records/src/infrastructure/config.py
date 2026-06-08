"""Single source of configuration (12-factor): ALL environment access lives here.

The platform binding contract injects these via envFrom "<component>-conn"
secrets when the OAM names sibling components (database:/cache: refs):
  DATABASE_URL (+ DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD)
  REDIS_URL / CACHE_URL (+ REDIS_HOST/REDIS_PORT/REDIS_PASSWORD)

Nothing else in the codebase reads os.environ — adapters receive Settings,
use cases receive ports. Swap config source (e.g. tests) by overriding the
FastAPI dependency or constructing Settings directly.
"""
import os
from dataclasses import dataclass, field


def _database_url() -> str:
    url = os.getenv("DATABASE_URL", "")
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg2://", 1)
    # channel_binding is a libpq>=13 param psycopg2 may not pass through; drop it
    return url.replace("&channel_binding=require", "").replace("channel_binding=require&", "")


@dataclass(frozen=True)
class Settings:
    database_url: str = field(default_factory=_database_url)
    redis_url: str = field(default_factory=lambda: os.getenv("REDIS_URL") or os.getenv("CACHE_URL") or "")
    jwt_issuer_uri: str = field(default_factory=lambda: os.getenv("JWT_ISSUER_URI", ""))
    jwt_jwk_set_uri: str = field(default_factory=lambda: os.getenv("JWT_JWK_SET_URI", ""))
    auth0_audience: str = field(default_factory=lambda: os.getenv("AUTH0_AUDIENCE", ""))
    port: int = field(default_factory=lambda: int(os.getenv("PORT", "8080")))
    # Knative injects K_SERVICE with the service name; falls back to the
    # template default for local runs.
    service_name: str = field(default_factory=lambda: os.getenv("K_SERVICE", "template-service"))


def load_settings() -> Settings:
    return Settings()
