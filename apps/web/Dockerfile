# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

# Copy workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/web/package.json ./apps/web/

RUN pnpm install --frozen-lockfile

COPY packages/core ./packages/core
COPY apps/web ./apps/web
COPY tsconfig.json ./

RUN pnpm --filter @infracanvas/core build && \
    pnpm --filter @infracanvas/web build

# Production stage
FROM nginx:alpine AS production

COPY apps/web/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

# Development stage
FROM node:20-alpine AS development

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

# Copy workspace config and source files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY packages/core ./packages/core
COPY apps/web ./apps/web

# Install dependencies and build core
RUN pnpm install --frozen-lockfile && \
    pnpm --filter @infracanvas/core build

EXPOSE 5173

CMD ["pnpm", "--filter", "@infracanvas/web", "dev", "--host", "0.0.0.0"]
