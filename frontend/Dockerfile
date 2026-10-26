# The build context is the repo root (compose.yaml: context: .), because the image reads one file
# outside frontend/: content-build/media-config.json, the list of media origins.
FROM node:24-alpine AS build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
# The same path as in the repo, so `../content-build/media-config.json` works here as it does there.
COPY content-build/media-config.json /app/content-build/media-config.json
COPY frontend ./
# Shown in feedback reports. Set with --build-arg; after COPY so the npm ci layer stays cached.
ARG VITE_APP_VERSION=dev
ENV VITE_APP_VERSION=$VITE_APP_VERSION
# The Content-Security-Policy, from the media-config.json that the app and the content build also read.
# A bad origin in it stops the build here.
RUN node scripts/csp.mjs ../content-build/media-config.json csp.conf
RUN npm run build

FROM nginx:1.27-alpine
COPY frontend/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/frontend/csp.conf /etc/nginx/csp.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
# Skip the image's entrypoint scripts: they edit /etc/nginx as root.
ENTRYPOINT []
CMD ["nginx", "-e", "/dev/stderr", "-g", "daemon off;"]
