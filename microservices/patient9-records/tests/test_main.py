"""TDD tests following CLAUDE.md principles"""
import pytest
from fastapi.testclient import TestClient
from src.interface.api import app

client = TestClient(app)

def test_health_check():
    """Test health endpoint (TDD Red-Green-Refactor)"""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["service"] == "template-service"

def test_readiness_check():
    """Test readiness endpoint"""
    response = client.get("/ready")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ready"

def test_root_endpoint():
    """Test root endpoint"""
    response = client.get("/")
    assert response.status_code == 200
    data = response.json()
    assert "Hello from" in data["message"]
    assert data["architecture"] == "onion"