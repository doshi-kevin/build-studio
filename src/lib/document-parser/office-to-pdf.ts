// Converts an office document (PPTX/PPT — see OFFICE_EXTS in asset-crop.ts, the
// only caller) to PDF so the PDF page renderer can produce a faithful page image
// for citation previews and the vector index can embed real pages.
//
// The conversion itself happens in the ISOLATED Gotenberg service on Cloud Run
// (src/lib/live-classroom/deck-converter.ts) — NOT in this process. That is the
// whole point of this module now: an office file is a zip of instructions, and
// LibreOffice will follow them, including resolving external OLE/image links. Run
// in-process, a crafted upload could make the app's own container fetch internal
// URLs (the Cloud Run metadata endpoint, internal services) or read local files
// into the rendered output, and a complex deck could pin the serving instance's
// CPU/RAM inside the request. In the converter, a malicious deck reaches a
// separate service that is IAM-locked, concurrency 1, and has its own memory/CPU
// ceiling — instead of the container holding SUPABASE_SERVICE_ROLE_KEY.
// (GitHub issue #182.)
//
// What this does NOT close, so nobody reads more into it than it earns: both
// services currently run as the project's DEFAULT compute service account, so
// code execution inside the converter could still mint a metadata token for it.
// The follow-up is a dedicated zero-role service account on the converter, not an
// egress flag (it has no VPC connector, and the metadata endpoint is link-local
// and unaffected by VPC egress settings either way).
//
// This module is the thin adapter between that client and this pipeline's
// contract: take a buffer + source extension, return a PDF buffer or NULL. Never
// throws — callers degrade to "couldn't render" / a failed extraction rather than
// crashing an upload.
//
// Local dev: run Gotenberg alongside the app
// (`docker run --rm -p 3001:3000 gotenberg/gotenberg:8`, then
// GOTENBERG_URL=http://localhost:3001 + GOTENBERG_SKIP_AUTH=true). With
// GOTENBERG_URL unset, office conversion returns null and PDFs keep working —
// see infra/microservices/deck-converter/README.md.
//
// Conversion is the heavy step, so callers convert ONCE per file and cache the
// resulting PDF in storage; here we just do the buffer→buffer convert.

import { convertOfficeToPdf as convertViaService, isPptxEnabled } from '@/lib/live-classroom/deck-converter'
import { logger } from '@/lib/logger'

/**
 * Default conversion ceiling for this pipeline: under the 60s `maxDuration` of
 * the citation-preview route (`/api/extraction/page`), which is the tightest
 * caller. The converter client's own default is 120s — fine for the 900s
 * extraction worker, but it would let that route die before the converter
 * answers, so callers on a longer budget opt in explicitly instead.
 */
export const OFFICE_CONVERT_TIMEOUT_MS = 45_000

/**
 * Convert an office document buffer to a PDF buffer. `ext` is the source
 * extension (e.g. 'pptx') — it is what LibreOffice picks its import filter from,
 * so it must be right. Returns null on any failure (converter unconfigured,
 * timeout, non-200, or a 200 that isn't a PDF).
 */
export async function convertOfficeToPdf(
  input: Buffer,
  ext: string,
  timeoutMs: number = OFFICE_CONVERT_TIMEOUT_MS,
): Promise<Buffer | null> {
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'pptx'
  if (!isPptxEnabled()) {
    logger.warn('convertOfficeToPdf: converter not configured (GOTENBERG_URL unset)', {
      source: 'documentParser.convertOfficeToPdf',
      ext: safeExt,
    })
    return null
  }
  try {
    const out = await convertViaService(input, `input.${safeExt}`, { timeoutMs })
    // Gotenberg signals failure with a non-200, so a 200 that isn't a PDF means
    // something between us and it answered (proxy error page, truncated body).
    // Checked here rather than trusted, because the caller CACHES this buffer as
    // `<path>.pdf` with upsert — bad bytes would be the permanent derived PDF for
    // that file, failing every later preview until someone deletes the object by
    // hand. Cheap check, unbounded blast radius if skipped.
    if (out.subarray(0, 4).toString('latin1') !== '%PDF') {
      logger.error('convertOfficeToPdf: converter returned a non-PDF body', null, {
        source: 'documentParser.convertOfficeToPdf',
        ext: safeExt,
        bytes: out.length,
      })
      return null
    }
    return out
  } catch (err) {
    logger.error('convertOfficeToPdf: conversion failed', err, { ext: safeExt })
    return null
  }
}
