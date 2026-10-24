FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
# Skip the image's entrypoint scripts: they edit /etc/nginx as root.
ENTRYPOINT []
CMD ["nginx", "-e", "/dev/stderr", "-g", "daemon off;"]
