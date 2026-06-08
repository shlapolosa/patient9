"""Main application entry point following 12-factor principles"""
import uvicorn

# Absolute imports via the src package: the container runs `python -m src.main`,
# so `src` is the package root - never import the subpackages as top-level
# (that breaks api.py's relative imports with "beyond top-level package").
from src.infrastructure.config import load_settings
from src.interface.api import app

if __name__ == "__main__":
    # 12-Factor: Port binding — config via the single Settings source
    uvicorn.run(app, host="0.0.0.0", port=load_settings().port)
