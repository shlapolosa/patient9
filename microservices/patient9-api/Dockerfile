# Multi-stage build for production
FROM python:3.11-slim as builder

# Install Poetry and basic build tools
RUN apt-get update && apt-get install -y curl gcc && rm -rf /var/lib/apt/lists/*
RUN pip install poetry

# Set working directory for build
WORKDIR /build

# Copy dependency files
COPY pyproject.toml ./

# Configure poetry and install dependencies without dev packages (no-root to skip project install)
RUN poetry config virtualenvs.create false \
    && poetry install --only=main --no-root --no-interaction --no-ansi

# Production stage
FROM python:3.11-slim as production

# Install curl for health checks
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Create non-root user (security best practice)
RUN useradd --create-home --shell /bin/bash app

# Copy installed packages from builder
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Set working directory
WORKDIR /app

# Copy application code
COPY --chown=app:app src/ src/

# Switch to non-root user
USER app

# Set PYTHONPATH for proper module imports
ENV PYTHONPATH=/app/src

# 12-Factor: Port binding
EXPOSE 8080

# Health check with better error handling
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Start application
CMD ["python", "-m", "src.main"]