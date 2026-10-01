'use client'

/**
 * The composer half of Athena's attachment pipeline, shared by the professor
 * console and the student dock.
 *
 * One state machine: pick files → validate against this surface's limits →
 * upload each in parallel → a chip goes ready (with its storage path) or errors
 * → send turns the ready ones into AI SDK file parts → clear.
 *
 * The client-side validation here is for SPEED, not safety — it fails an
 * oversized or unsupported file instantly instead of after a round trip. Both
 * upload routes re-run the same `validateAthenaUpload` server-side against the
 * same limits, and that copy is the one that decides.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { extOf, validateAthenaUpload } from '@/lib/ai/athena-attachments'
import type { AthenaAttachmentLimits } from '@/lib/ai/professor-assistant/models'

/** A file the user has attached: tracked from upload → ready/error. */
export interface PendingAttachment {
  id: string
  displayName: string
  ext: string
  sizeBytes: number
  status: 'uploading' | 'ready' | 'error'
  path?: string
  mediaType?: string
  signedUrl?: string
  error?: string
}

/**
 * A file part on the wire: a fresh signed URL for optimistic display, plus the
 * DURABLE storage path in providerMetadata. The server persists the path and
 * inlines the bytes for the model; it never trusts the URL.
 */
export interface AthenaFilePart {
  type: 'file'
  mediaType: string
  filename: string
  url: string
  providerMetadata: { athena: { path: string } }
}

export function useAthenaAttachments({
  limits,
  endpoint,
  fields,
}: {
  limits: AthenaAttachmentLimits
  /** Upload route — takes multipart `file` plus `fields`, returns the stored path. */
  endpoint: string
  /** Extra form fields the route needs (sectionId, conversationId, modelId…). */
  fields: Record<string, string>
}) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])

  // Read through a ref so a changing field (the professor's model picker) never
  // re-creates the upload callbacks mid-flight.
  const fieldsRef = useRef(fields)
  useEffect(() => {
    fieldsRef.current = fields
  })

  const uploadOne = useCallback(
    async (id: string, file: File) => {
      try {
        const fd = new FormData()
        fd.append('file', file)
        for (const [k, v] of Object.entries(fieldsRef.current)) fd.append(k, v)
        const res = await fetch(endpoint, { method: 'POST', body: fd })
        const json = await res.json().catch(() => null)
        if (!res.ok) throw new Error(json?.error || 'Upload failed')
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === id
              ? { ...a, status: 'ready', path: json.path, mediaType: json.mediaType, signedUrl: json.signedUrl }
              : a,
          ),
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Upload failed'
        setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: 'error', error: msg } : a)))
        // Client-side validation rejects already toast before becoming a chip; an
        // upload-time failure only turned the chip red with the reason in an sr-only
        // span, so a sighted professor saw "something's wrong" but not what. Toast it
        // for visual parity (screen readers still get the chip's sr-only text).
        toast.error(msg)
      }
    },
    [endpoint],
  )

  /**
   * Stage files for the next send. Returns the ones that PASSED validation, so a
   * caller that does something else with the same file (the quiz studio also
   * registers it as course material) can skip that work when nothing was staged.
   * Rejections are reported to the user here, by toast; the return value exists
   * for the caller's control flow, not to be re-reported.
   */
  const addFiles = useCallback(
    (incoming: File[]): File[] => {
      const accepted: { id: string; file: File; ext: string }[] = []
      let slots = limits.maxFiles - attachments.length
      for (const file of incoming) {
        if (slots <= 0) {
          toast.error(`You can attach up to ${limits.maxFiles} file${limits.maxFiles === 1 ? '' : 's'}`)
          break
        }
        const valid = validateAthenaUpload(file.name, file.size, limits)
        if ('error' in valid) {
          toast.error(valid.error)
          continue
        }
        accepted.push({ id: crypto.randomUUID(), file, ext: extOf(file.name) })
        slots--
      }
      if (accepted.length === 0) return []
      setAttachments((prev) => [
        ...prev,
        ...accepted.map((a) => ({
          id: a.id,
          displayName: a.file.name,
          ext: a.ext,
          sizeBytes: a.file.size,
          status: 'uploading' as const,
        })),
      ])
      for (const a of accepted) void uploadOne(a.id, a.file)
      return accepted.map((a) => a.file)
    },
    [limits, attachments.length, uploadOne],
  )

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const clear = useCallback(() => setAttachments([]), [])

  return {
    attachments,
    addFiles,
    removeAttachment,
    clear,
    /** At least one file is still uploading — sending now would drop it. */
    uploading: attachments.some((a) => a.status === 'uploading'),
    canAttach: attachments.length < limits.maxFiles,
    /** The uploaded files, as the parts to hand `sendMessage`. */
    readyFileParts: (): AthenaFilePart[] =>
      attachments
        .filter((a) => a.status === 'ready' && a.path)
        .map((a) => ({
          type: 'file' as const,
          mediaType: a.mediaType as string,
          filename: a.displayName,
          url: a.signedUrl as string,
          providerMetadata: { athena: { path: a.path as string } },
        })),
  }
}
