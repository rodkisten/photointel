# syntax=docker/dockerfile:1.29
FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY apps/web/package*.json ./
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --strict-ssl=true
COPY apps/web/ ./
ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.31-alpine
COPY --chmod=0644 infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=101:101 /app/dist /usr/share/nginx/html
EXPOSE 8080
STOPSIGNAL SIGQUIT
