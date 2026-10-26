FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Shown in feedback reports. Set with --build-arg; after COPY so the npm ci layer stays cached.
ARG VITE_APP_VERSION=dev
ENV VITE_APP_VERSION=$VITE_APP_VERSION
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
# Skip the image's entrypoint scripts: they edit /etc/nginx as root.
ENTRYPOINT []
CMD ["nginx", "-e", "/dev/stderr", "-g", "daemon off;"]
