# Multi-stage Dockerfile for deploying Scholera (Next.js) to Google Cloud Run.
# Uses standalone output for a minimal production image.

# --- Stage 1: Install dependencies ---
FROM node:22-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# --- Stage 2: Build the application ---
FROM node:22-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next.js inlines NEXT_PUBLIC_* vars into the client bundle at build time.
# These are public keys (exposed in browser anyway), safe to bake in here.
#
# They are ARGs so a non-prod build (e.g. infra/app/cloudbuild.staging.yaml) can
# point the image at a different Supabase project via --build-arg. The DEFAULTS
# are the PRODUCTION values, so the "lazy path" — `gcloud run deploy --source`
# with no build-args (infra/app/deploy-to-prod.sh) — always produces a prod image,
# never an accidental staging one.
ARG NEXT_PUBLIC_SUPABASE_URL=https://ywdqaoahfmmzcsczxvxn.supabase.co
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3ZHFhb2FoZm1temNzY3p4dnhuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4MjE0NzMsImV4cCI6MjA4NjM5NzQ3M30.Q3eAnJ3f0A3__dVRWg0DlKLwUnzRmsM6Sk1-gVrp8bQ
# Kept empty on purpose: NEXT_PUBLIC_SITE_URL is inlined at build time, so a
# baked-in value can't be corrected at deploy. Server code reads the runtime
# SITE_URL env var instead (set on the Cloud Run service; see
# src/lib/site-url.ts). Staging still overrides this ARG for client-side use.
ARG NEXT_PUBLIC_SITE_URL=
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# --- Stage 3: Production runner ---
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Cloud Run expects port 8080
ENV PORT=8080

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Enforced by src/__tests__/office-conversion-coverage.test.ts, which fails if any
# libreoffice-* package or the soffice binary reappears in an install line. Added
# because reinstating a package to "fix" a failed conversion works, and silently
# undoes the isolation below.
#
# NO LibreOffice here, deliberately (GitHub issue #182). Office → PDF conversion
# runs in the isolated Gotenberg service on Cloud Run
# (infra/microservices/deck-converter/), because a crafted PPTX can make
# LibreOffice resolve external links — in-process that reads the app container's
# own metadata endpoint and internal services, and pins its CPU inside a request.
# Out of the image it also drops ~300MB and one apt layer from every deploy.
#
# Fonts STAY. They are not LibreOffice's: pdfjs rasterization falls back to system
# fonts for PDFs that don't embed theirs, and the metric-compatible Carlito/Caladea
# substitute for Calibri/Cambria so a rendered page doesn't reflow.
RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-liberation \
      fonts-crosextra-carlito \
      fonts-crosextra-caladea \
      fonts-dejavu-core \
      fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*

# Copy the standalone server and static assets
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

USER nextjs
EXPOSE 8080

CMD ["node", "server.js"]
