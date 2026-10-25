# The build context is the repo root (see compose.yaml), because the first stage needs courses/,
# content-build/, and the component schemas of the frontend. backend/Dockerfile.dockerignore keeps the context small.

# Stage 1: build the course content (lesson trees, quizzes, code steps, assets, manifests).
# The Node major version equals .nvmrc. Only the output is copied to the runtime image.
FROM node:24-alpine AS content
WORKDIR /repo
COPY content-build/package.json content-build/package-lock.json content-build/
RUN cd content-build && npm ci
COPY content-build content-build
# The content build reads the component schemas from the frontend's folder, at the same relative place as in the repo.
COPY frontend/src/content-components/schemas frontend/src/content-components/schemas
# The courses to build. The image holds the output of every course in this folder; the COURSES variable at run
# time chooses what is served. A build argument can point to another folder (the image check uses a fixture).
ARG COURSES_DIR=courses
COPY ${COURSES_DIR} courses
# COURSES is not read at image build: it is not an ARG or an ENV here, so every course is built.
RUN cd content-build && npm run build -- ../courses ../build

FROM python:3.12-slim AS build
# uv is a build tool only; the final image gets just the virtualenv.
RUN pip install --no-cache-dir uv==0.11.32
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy
WORKDIR /build
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev

FROM python:3.12-slim
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    COURSE_BUILD_DIR=/app/course-build
RUN useradd --system --uid 10001 --no-create-home app
COPY --from=build /opt/venv /opt/venv
WORKDIR /app
COPY backend/alembic.ini backend/docker-entrypoint.sh ./
COPY backend/migrations ./migrations
COPY backend/app ./app
# The output of the content build: private/ (read by the backend only), public/, and assets-map/.
COPY --from=content /repo/build /app/course-build
USER app
EXPOSE 8000
# Runs `alembic upgrade head` first if compose.yaml (or the caller) asks for it, then the CMD.
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
# --no-proxy-headers: uvicorn must not rewrite the client address from X-Forwarded-For. The app decides
# itself, from TRUSTED_PROXIES (app/client_address.py).
# --log-config: every line, uvicorn's own included, is one JSON object (app/log_config.json).
# --no-access-log: the app writes one "request completed" line per request instead, without the query string.
# One process per container (no worker option): the metrics and the pool gauges are per process (see the README).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers", "--no-access-log", "--log-config", "app/log_config.json"]
