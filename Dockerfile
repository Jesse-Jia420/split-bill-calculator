# split-bill-calculator Dockerfile (v1.0 release prep)
# 反 #160: BE + FE 都必须 --host 0.0.0.0, 否则 cloudflared 进不来
# 反 #119: dev/prod 配置分离, env vars
# 反 #159: 启动必分次报告 + 验证 PID
#
# 多阶段构建:
#   Stage 1 (fe-build): Node 22 → sveltekit build (vite build → frontend/build)
#   Stage 2 (runtime): Python 3.12 + Node 22 → BE uvicorn + FE node preview
#   Stage 3 (image): entrypoint.sh 同时跑 BE + FE + 健康检查
#
# 端口:
#   8449 (BE uvicorn, 内部)
#   8448 (FE sveltekit adapter-node, 暴露给 cloudflared)
#
# 数据:
#   SQLite 持久化到 /app/backend/data/sbc.db (volume 挂载)

# ====== Stage 1: FE build ======
FROM node:22-alpine AS fe-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# sveltekit build → /build/frontend/build (node server entry)
RUN npm run build

# ====== Stage 2: runtime (Python BE + Node FE + entrypoint) ======
FROM python:3.12-slim AS runtime

# Install curl for healthcheck + Node 22 for FE runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# BE deps (install from pyproject.toml)
COPY backend/pyproject.toml backend/uv.lock* /app/backend/
RUN pip install --no-cache-dir --upgrade pip \
    && cd /app/backend && pip install --no-cache-dir -e .

# BE code
COPY backend/ /app/backend/

# FE build artifacts (from stage 1)
COPY --from=fe-build /build/frontend/ /app/frontend/
# Install only production deps (skip devDependencies)
WORKDIR /app/frontend
RUN npm ci --omit=dev --no-audit --no-fund
WORKDIR /app

# Entrypoint script (同时启动 BE + FE, 反 #160 都 --host 0.0.0.0)
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Expose ports
EXPOSE 8449 8448

# Health check (BE /version)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://localhost:8449/version || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
