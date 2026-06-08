# GraphQL Mesh Gateway Docker Image
# Multi-stage build for optimized production image with proper native dependency compilation
FROM node:18-alpine AS builder

# Install build dependencies for node-gyp compilation
RUN apk add --no-cache --virtual .build-deps \
    bash \
    curl \
    jq \
    git \
    python3 \
    make \
    g++ \
    libc6-compat \
    libstdc++ \
    pkgconfig \
    autoconf \
    automake \
    libtool \
    nasm \
    build-base

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies for building (including native compilation)
RUN npm install --legacy-peer-deps

# Copy application source
COPY src/ ./src/
COPY mesh-config-template.yaml ./
COPY generate-mesh-config.sh ./
# Main entry point is src/index.js
COPY start.sh ./

# Make scripts executable
RUN chmod +x generate-mesh-config.sh start.sh

# Clean up build dependencies to reduce image size
RUN apk del .build-deps

# Production stage
FROM node:18-alpine AS production

# Install only runtime dependencies
RUN apk add --no-cache \
    bash \
    curl \
    jq \
    yq \
    kubectl \
    git \
    libc6-compat

# Set working directory
WORKDIR /app

# Copy built application and compiled dependencies from builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/mesh-config-template.yaml ./
COPY --from=builder /app/generate-mesh-config.sh ./
# Main entry point is src/index.js (already copied with src/)
COPY --from=builder /app/start.sh ./
COPY --from=builder /app/package*.json ./

# Ensure scripts are executable
RUN chmod +x generate-mesh-config.sh start.sh

# Create non-root user
RUN addgroup -g 1001 -S mesh && \
    adduser -S mesh -u 1001 -G mesh

# Change ownership of the app directory
RUN chown -R mesh:mesh /app

# Switch to non-root user
USER mesh

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Start the application
ENTRYPOINT ["./start.sh"]