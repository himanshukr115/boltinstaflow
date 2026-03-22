# =============================================================================
# Stage 1: Production dependency installer
# Installs only production dependencies to keep the final image lean.
# =============================================================================
FROM node:18-alpine AS builder

WORKDIR /app

# Copy dependency manifests first to leverage Docker layer caching.
# If package files don't change, npm ci is skipped on subsequent builds.
COPY package.json package-lock.json ./

# Install production dependencies only. npm ci ensures a reproducible install
# from the lockfile and is faster than npm install in CI/CD pipelines.
RUN npm ci --only=production && \
    # Remove npm cache to reduce layer size
    npm cache clean --force


# =============================================================================
# Stage 2: CSS build
# Compiles Tailwind CSS with PurgeCSS tree-shaking in production mode.
# Kept as a separate stage so dev dependencies never reach the final image.
# =============================================================================
FROM node:18-alpine AS css-builder

WORKDIR /app

# Copy manifests and install ALL dependencies (including tailwindcss dev dep)
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

# Copy source files that Tailwind needs to scan for class names
COPY src/ ./src/
COPY views/ ./views/
COPY tailwind.config.js ./

# Copy public directory so the input CSS entrypoint is available
COPY public/ ./public/

# Build and minify CSS. Output goes to public/css/output.css
RUN npm run build:css


# =============================================================================
# Stage 3: Production runtime image
# Minimal Alpine-based image containing only what is needed to run the app.
# =============================================================================
FROM node:18-alpine AS production

# Install dumb-init for proper signal handling and process reaping inside
# Docker containers running Node.js. Also install curl for the HEALTHCHECK.
RUN apk add --no-cache dumb-init curl

WORKDIR /app

# Switch to the non-root "node\" user that ships with the official Node image.
# All subsequent COPY/RUN instructions execute as this user.
USER node

# Copy production node_modules from Stage 1.
# Using --chown to ensure the node user owns the files.
COPY --chown=node:node --from=builder /app/node_modules ./node_modules

# Copy compiled CSS from Stage 2.
COPY --chown=node:node --from=css-builder /app/public/css/output.css ./public/css/output.css

# Copy application source code.
# Order matters: copy files that change least frequently first to maximise
# layer cache reuse between deployments.
COPY --chown=node:node public/ ./public/
COPY --chown=node:node views/ ./views/
COPY --chown=node:node src/ ./src/
COPY --chown=node:node server.js ./
COPY --chown=node:node package.json ./

# Runtime environment
ENV NODE_ENV=production \
    PORT=3000 \
    # Emit unhandled promise rejection warnings as errors in production
    NODE_OPTIONS="--unhandled-rejections=throw"

# The application binds to this port
EXPOSE 3000

# Health check: poll the /healthz endpoint every 30 seconds.
# The app must respond within 10 seconds; 3 consecutive failures mark
# the container as unhealthy. Allow 40 seconds for startup before checking.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -fs http://localhost:3000/healthz || exit 1

# Use dumb-init as PID 1 to handle OS signals correctly (SIGTERM → graceful shutdown)
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

CMD ["node", "server.js"]
