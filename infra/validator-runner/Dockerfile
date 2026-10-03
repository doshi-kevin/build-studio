# Studio Stage 2 validator runner: the image the Cloud Run job studio-validator-runner
# runs, one fresh container per validation. See README.md in this folder.
#
# The build context is a staging directory deploy.sh assembles, holding this file and
# validator-runtime/dist (from `node validator-runtime/build.mjs`). Nothing else from the
# repository is in the image: no source, no .env files, no node_modules beyond the
# browser driver build.mjs copies into dist.
#
# The base is pinned by digest. deploy.sh passes it and refuses to build without one.
# An empty digest fails here too: "...-noble@sha256:" is not a valid image reference.
ARG PLAYWRIGHT_IMAGE_DIGEST
FROM mcr.microsoft.com/playwright:v1.61.0-noble@sha256:${PLAYWRIGHT_IMAGE_DIGEST}

WORKDIR /app
# Owned by root and read-only to the runtime user, so the runner can't rewrite itself.
COPY validator-runtime/dist ./dist

# The base image's non-root user (uid 1001). The browsers live in /ms-playwright, which
# the base image sets as PLAYWRIGHT_BROWSERS_PATH. Chromium's sandbox stays on: the
# runner launches with chromiumSandbox: true and never passes a flag that disables it.
USER pwuser

# The job sets VALIDATION_ID, PAYLOAD_URL and REPORT_URL per execution. No credentials
# are baked in or mounted.
CMD ["node", "dist/cloud-entry.mjs"]
