# Admin web app container (Vite build -> nginx).
#
# The Dockerfile and nginx.conf live IN admin-app/ so the admin app is
# self-contained in one folder (matching how the gateway keeps cdk/Dockerfile
# next to its build inputs). The build CONTEXT is still the repo root, because
# the COPY paths are repo-root-relative (admin-app/...). Pass the Dockerfile
# explicitly with -f:
#   docker build --platform=linux/amd64 --provenance=false \
#     -f admin-app/Dockerfile -t <uri>:latest .

FROM node:20-alpine AS builder
WORKDIR /app
COPY admin-app/package.json admin-app/package-lock.json ./
RUN npm ci
COPY admin-app/ .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY admin-app/nginx.conf /etc/nginx/templates/default.conf.template
EXPOSE 3000
