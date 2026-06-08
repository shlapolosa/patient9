"""FastAPI interface layer following CLAUDE.md 12-factor principles.

DI wiring: concrete adapters are chosen from the platform binding contract
(DATABASE_URL / REDIS_URL injected via "<component>-conn" envFrom when the
OAM sets database:/cache: refs) and injected into use cases via Depends.
Unbound = in-memory + no-op cache: the template runs anywhere.
"""
from functools import lru_cache
from typing import List, Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel

from ..application.use_cases import CreateItem, GetItem, ListItems
from ..domain.models import Item
from ..domain.repositories import Cache, ItemRepository
from ..infrastructure.auth import get_verifier
from ..infrastructure.cache import NullCache, get_cache
from ..infrastructure.config import Settings, load_settings
from ..infrastructure.database import get_engine
from ..infrastructure.repositories import InMemoryItemRepository, SqlItemRepository

app = FastAPI(
    title=load_settings().service_name,
    description="CLAUDE.md-compliant microservice with Onion Architecture",
    version="0.1.0",
)


# ---- Dependency injection (composition root) --------------------------------

@lru_cache
def _settings() -> Settings:
    """12-factor config enters the app HERE and only here."""
    return load_settings()


@lru_cache
def _repository() -> ItemRepository:
    engine = get_engine(_settings())
    if engine is not None:
        return SqlItemRepository(engine)
    return InMemoryItemRepository()


@lru_cache
def _cache() -> Cache:
    return get_cache(_settings())


@lru_cache
def _verifier():
    return get_verifier(_settings())


def require_auth(request: Request):
    """Identity binding: verifies Bearer JWT when `identity:` is bound; no-op when open."""
    return _verifier().verify(request)


def get_create_item(repo: ItemRepository = Depends(_repository),
                    cache: Cache = Depends(_cache)) -> CreateItem:
    return CreateItem(repo, cache)


def get_get_item(repo: ItemRepository = Depends(_repository),
                 cache: Cache = Depends(_cache)) -> GetItem:
    return GetItem(repo, cache)


def get_list_items(repo: ItemRepository = Depends(_repository),
                   cache: Cache = Depends(_cache)) -> ListItems:
    return ListItems(repo, cache)


# ---- Health ------------------------------------------------------------------

class HealthResponse(BaseModel):
    status: str
    service: str
    database: str = "unbound"
    cache: str = "unbound"


def _binding_status() -> dict:
    settings = _settings()
    db = "unbound"
    if settings.database_url:
        try:
            engine = get_engine(settings)
            with engine.connect() as conn:
                conn.exec_driver_sql("SELECT 1")
            db = "connected"
        except Exception:
            db = "error"
    cache = "unbound"
    if settings.redis_url:
        cache = "configured" if not isinstance(_cache(), NullCache) else "error"
    return {"database": db, "cache": cache}


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint for Kubernetes probes (always healthy; bindings reported)."""
    return HealthResponse(status="healthy", service=_settings().service_name, **_binding_status())


@app.get("/ready", response_model=HealthResponse)
async def readiness_check():
    """Readiness check endpoint for Kubernetes probes"""
    return HealthResponse(status="ready", service=_settings().service_name, **_binding_status())


@app.get("/")
async def root():
    """Root endpoint"""
    return {"message": f"Hello from {_settings().service_name}", "architecture": "onion"}


# ---- Sample vertical slice: /items -------------------------------------------

class CreateItemRequest(BaseModel):
    name: str
    description: str = ""


@app.post("/items", response_model=Item, status_code=201)
def create_item(req: CreateItemRequest, uc: CreateItem = Depends(get_create_item),
                claims=Depends(require_auth)):
    return uc.execute(name=req.name, description=req.description)


@app.get("/items", response_model=List[Item])
def list_items(uc: ListItems = Depends(get_list_items), claims=Depends(require_auth)):
    return uc.execute()


@app.get("/items/{item_id}", response_model=Item)
def get_item(item_id: str, uc: GetItem = Depends(get_get_item), claims=Depends(require_auth)):
    item: Optional[Item] = uc.execute(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="item not found")
    return item
