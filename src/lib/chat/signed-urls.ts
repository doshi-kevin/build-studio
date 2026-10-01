/**
 * Signed-URL cache + batch resolver for chat attachments.
 *
 * The chat-attachments bucket is private, so message views must mint
 * a signed URL for each path on demand. We cache resolved URLs in a
 * module-level Map with an expiry timestamp; the `useChatAttachmentUrl`
 * hook batches unresolved paths per tick so a feed of 50 attachments
 * triggers one `createSignedUrls` call, not 50.
 *
 * TTL is intentionally short (matches CHAT_SIGNED_URL_TTL_SECONDS); we
 * re-sign automatically when a cached entry is within the refresh
 * window.
 */
'use client'

import { useEffect, useState } from 'react'
import {
  CHAT_SIGNED_URL_TTL_SECONDS,
  signChatAttachmentPaths,
} from '@/lib/supabase/chat-storage'

interface CacheEntry {
  url: string
  /** Unix ms when this URL stops being safe to use. */
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

// Paths waiting to be signed on the next microtask. Keyed so we can
// dedupe in-flight requests for the same path.
const pendingPaths = new Set<string>()
const pendingResolvers = new Map<string, Array<(url: string | null) => void>>()
let flushScheduled = false

/** Refresh the URL once we're within this window of expiry. */
const REFRESH_WINDOW_MS = 60 * 1000 // 1 minute

function nowMs(): number {
  return Date.now()
}

function getFresh(path: string): string | null {
  const entry = cache.get(path)
  if (!entry) return null
  if (entry.expiresAt - nowMs() < REFRESH_WINDOW_MS) return null
  return entry.url
}

function storeEntry(path: string, url: string): void {
  cache.set(path, {
    url,
    expiresAt: nowMs() + CHAT_SIGNED_URL_TTL_SECONDS * 1000,
  })
}

function scheduleFlush(): void {
  if (flushScheduled) return
  flushScheduled = true
  // Microtask batching: any chip mounted in the same tick joins the
  // same batch request. Fallback to setTimeout 0 for environments
  // without queueMicrotask.
  const schedule =
    typeof queueMicrotask === 'function'
      ? queueMicrotask
      : (fn: () => void) => setTimeout(fn, 0)
  schedule(async () => {
    flushScheduled = false
    const paths = Array.from(pendingPaths)
    pendingPaths.clear()
    if (paths.length === 0) return

    const signed = await signChatAttachmentPaths(paths)

    for (const path of paths) {
      const url = signed.get(path) ?? null
      if (url) storeEntry(path, url)
      const resolvers = pendingResolvers.get(path)
      if (resolvers) {
        pendingResolvers.delete(path)
        for (const r of resolvers) r(url)
      }
    }
  })
}

function requestSignedUrl(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    const existing = pendingResolvers.get(path)
    if (existing) {
      existing.push(resolve)
    } else {
      pendingResolvers.set(path, [resolve])
    }
    pendingPaths.add(path)
    scheduleFlush()
  })
}

/**
 * React hook — resolves a stored `attachment_path` into a signed URL.
 *
 * - `null` path → `null` URL (no attachment).
 * - Already-cached + fresh → returns synchronously via initial state.
 * - Otherwise → initiates a batched fetch, returns `null` until ready.
 */
export function useChatAttachmentUrl(path: string | null): string | null {
  const [asyncUrl, setAsyncUrl] = useState<string | null>(null)
  const [lastPath, setLastPath] = useState<string | null>(path)

  // Reset async state during render when path changes — React's
  // recommended pattern for syncing state with a prop without
  // touching setState inside an effect.
  if (path !== lastPath) {
    setLastPath(path)
    setAsyncUrl(null)
  }

  const syncUrl = path ? getFresh(path) : null

  useEffect(() => {
    if (!path) return
    if (getFresh(path)) return
    let cancelled = false
    requestSignedUrl(path).then((resolved) => {
      if (!cancelled) setAsyncUrl(resolved)
    })
    return () => {
      cancelled = true
    }
  }, [path])

  return syncUrl ?? asyncUrl
}

/** Test hook — clear the cache between test runs. */
export function __resetSignedUrlCacheForTests(): void {
  cache.clear()
  pendingPaths.clear()
  pendingResolvers.clear()
  flushScheduled = false
}
