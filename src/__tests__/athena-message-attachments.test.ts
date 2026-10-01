// Reopening a thread must give the student back the files they attached — and,
// less visibly, must give the SERVER back the storage path, or a follow-up
// question in that thread silently loses the attachment the whole turn was about.
import { describe, it, expect } from 'vitest'
import { dbMessageToUIMessage, messageAttachments, type DbMessage } from '@/lib/ai/conversation-utils'
import { asFilePart, athenaPathOf, materializeFileParts } from '@/lib/ai/athena-attachments-server'

const PATH = 'inst-1/sec-1/student-1/abc.pdf'

function row(over: Partial<DbMessage>): DbMessage {
  return {
    id: 'm1',
    conversation_id: 'c1',
    role: 'user',
    content: '',
    metadata: {},
    created_at: '2026-07-31T00:00:00Z',
    ...over,
  }
}

const attachment = { path: PATH, filename: 'problem-set.pdf', mediaType: 'application/pdf' }

describe('messageAttachments', () => {
  it('reads the attachment list off a row', () => {
    expect(messageAttachments(row({ metadata: { attachments: [attachment] } }))).toHaveLength(1)
  })

  it('tolerates rows written before attachments existed, and junk', () => {
    expect(messageAttachments(row({}))).toEqual([])
    expect(messageAttachments(row({ metadata: { attachments: 'nope' } as never }))).toEqual([])
    expect(messageAttachments(row({ metadata: { attachments: [{ nope: 1 }] } as never }))).toEqual([])
  })
})

describe('dbMessageToUIMessage', () => {
  it('carries the durable path back, not just the (expiring) signed URL', () => {
    const ui = dbMessageToUIMessage(
      row({
        content: 'is question 3 right?',
        metadata: { attachments: [{ ...attachment, signedUrl: 'https://signed.example/x?token=1' }] },
      }),
    )
    const fp = asFilePart(ui.parts[0])
    expect(fp).not.toBeNull()
    // The chip links to the signed URL…
    expect(fp!.url).toBe('https://signed.example/x?token=1')
    // …but the next turn re-sends the path, which is what the route re-checks
    // and downloads. A signed URL alone would be unusable an hour later.
    expect(athenaPathOf(fp!)).toBe(PATH)
  })

  it('falls back to the bare path when signing failed — still resolvable server-side', () => {
    const ui = dbMessageToUIMessage(row({ metadata: { attachments: [attachment] } }))
    expect(athenaPathOf(asFilePart(ui.parts[0])!)).toBe(PATH)
  })

  it('drops the empty text part of a file-only turn, but never leaves a message partless', () => {
    const fileOnly = dbMessageToUIMessage(row({ metadata: { attachments: [attachment] } }))
    expect(fileOnly.parts).toHaveLength(1)
    expect(fileOnly.parts[0].type).toBe('file')

    // No attachment → the text part stays even when empty, so the message is
    // never an empty parts array (convertToModelMessages rejects those).
    const plain = dbMessageToUIMessage(row({ content: '' }))
    expect(plain.parts).toEqual([{ type: 'text', text: '' }])
  })

  it('puts files before the text, matching how the bubble stacks them', () => {
    const ui = dbMessageToUIMessage(
      row({ content: 'here', metadata: { attachments: [attachment] } }),
    )
    expect(ui.parts.map((p) => p.type)).toEqual(['file', 'text'])
  })
})

// An attachment is re-inlined on every LATER turn of a thread, so the cap is
// what stops three big PDFs becoming a permanent per-message tax. What it drops
// matters as much as that it drops: the oldest files go, the current question's
// files always stay.
describe('materializeFileParts — inline cap', () => {
  const prefix = 'inst-1/sec-1/student-1/'
  // A real stored path is {prefix}{uuid}.{ext} — pathInScope now requires the
  // remainder to be exactly that, so the fixtures use valid UUID filenames. The
  // display filename (`f${n}.pdf`) is what the stood-down note names.
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const filePart = (n: number) => ({
    type: 'file' as const,
    mediaType: 'application/pdf',
    filename: `f${n}.pdf`,
    url: `${prefix}${uuid(n)}.pdf`,
  })
  const turn = (n: number) =>
    ({ id: `m${n}`, role: 'user', parts: [filePart(n), { type: 'text', text: `q${n}` }] }) as never

  // Every download "succeeds" with one byte, so the test is about which parts
  // were downloaded at all — not about the bytes.
  const db = {
    storage: {
      from: () => ({
        download: async () => ({ data: { arrayBuffer: async () => new ArrayBuffer(1) }, error: null }),
      }),
    },
  } as never

  it('keeps the newest attachments and stands the older ones down', async () => {
    const out = await materializeFileParts(db, [turn(1), turn(2), turn(3)], prefix, 2)
    const kinds = out.map((m) => m.parts[0].type)
    // Oldest turn's file became a text note; the two newest stayed files.
    expect(kinds).toEqual(['text', 'file', 'file'])
    expect((out[0].parts[0] as { text: string }).text).toContain('f1.pdf')
    expect((out[0].parts[0] as { text: string }).text).toContain('no longer loaded')
  })

  it('inlines everything when no cap is given (the professor console)', async () => {
    const out = await materializeFileParts(db, [turn(1), turn(2), turn(3)], prefix)
    expect(out.map((m) => m.parts[0].type)).toEqual(['file', 'file', 'file'])
  })

  it('never downloads an out-of-scope path, cap or no cap', async () => {
    const forged = {
      id: 'm9',
      role: 'user',
      parts: [{ type: 'file', mediaType: 'application/pdf', filename: 'x.pdf', url: 'inst-2/sec-1/student-1/x.pdf' }],
    } as never
    const out = await materializeFileParts(db, [forged], prefix, 5)
    expect(out[0].parts[0]).toEqual({ type: 'text', text: '[Attachment "x.pdf" is unavailable.]' })
  })
})
