"""Domain models following CLAUDE.md Onion Architecture"""
from abc import ABC
from datetime import datetime, timezone
from typing import Optional
from pydantic import BaseModel, Field


class Entity(BaseModel):
    """Base domain entity"""
    id: Optional[str] = None


class Item(Entity):
    """Sample domain entity — the vertical slice every scaffold ships with.

    Rename/replace with your real aggregate; the repository + use-case +
    API wiring around it shows the pattern (Onion + DI + binding contract).
    """
    name: str
    description: str = ""
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class DomainService(ABC):
    """Base domain service interface"""
    pass
