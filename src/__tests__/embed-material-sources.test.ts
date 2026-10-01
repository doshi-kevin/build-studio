// @vitest-environment node
//
// Which materials reach the vector index. The pipeline used to gate on
// `fileType === 'pdf'`, which excluded every PPTX lecture — and did it silently,
// because "not a PDF" is a legitimate outcome that removes vectors and reports
// success. A whole course of slide decks was therefore absent from retrieval:
// no reference rail, and Athena falling back to the full-course dump.
//
// The gate is now "can this be rendered to pages", answered by the same
// converter the material viewer uses. Three outcomes have to stay distinct:
// embed it, drop it, or fail loudly — the last one matters because a job that
// throws is retried, and a job that returns success is not.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/ai/usage', () => ({ recordAiUsage: vi.fn() }))

const loadRenderablePdf = vi.fn()
vi.mock('@/lib/document-parser/asset-crop', async (importOriginal) => ({
  // isRenderableSource stays REAL — it is the predicate under test.
  ...(await importOriginal<typeof import('@/lib/document-parser/asset-crop')>()),
  loadRenderablePdf: (...a: unknown[]) => loadRenderablePdf(...a),
}))

// One rendered page, so a successful run has something to embed.
vi.mock('@/lib/document-parser/page-renderer', () => ({
  renderPdfPages: vi.fn(async () => [{ pageNumber: 1, buffer: Buffer.from('png') }]),
}))

const upsertMaterialPageVectors = vi.fn(async () => {})
const deleteMaterialVectors = vi.fn(async () => 7)
vi.mock('@/lib/pinecone/data', () => ({
  upsertMaterialPageVectors: (...a: unknown[]) => upsertMaterialPageVectors(...(a as [])),
  deleteMaterialVectors: (...a: unknown[]) => deleteMaterialVectors(...(a as [])),
}))
vi.mock('@/lib/pinecone/embed', () => ({
  embedMaterialPage: vi.fn(async () => ({ values: [0.1], tokens: 5, estimated: false })),
}))

// The rail re-anchor at the end of the job. Its own behaviour is covered in
// topic-page-anchors.test.ts; what matters HERE is whether the pipeline calls
// it at all — this is the half of the fix that closes the extraction/embedding
// race, and nothing else would notice if it were unwired.
const storeTopicPageAnchors = vi.fn<(...a: unknown[]) => Promise<Record<string, number[]>>>(async () => ({}))
vi.mock('@/lib/pinecone/topic-pages', () => ({
  storeTopicPageAnchors: (...a: unknown[]) => storeTopicPageAnchors(...(a as [])),
}))

// The pipeline reads page text through pdfjs; one page of text is enough.
// Mutable so a test can hand the pipeline a page whose text layer is hostile.
const pdfText = { value: 'Attention is all you need' }
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [{ str: pdfText.value, hasEOL: true }] }),
        cleanup: () => {},
      }),
      destroy: async () => {},
    }),
  }),
}))

import { embedMaterialPipeline } from '@/lib/jobs/pipelines/embed-material'

const ITEM = '11111111-1111-4111-8111-111111111111'
const SECTION = 'sec-1'

/** An admin-client stub whose module_items row carries the given file path. */
function ctxFor(filePath: string, topics?: string[]) {
  const deletes: string[] = []
  const upserts: Record<string, unknown>[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain = (table: string): any => {
    const c: Record<string, unknown> = {}
    const self = () => c
    c.select = self
    c.eq = self
    c.lt = self
    c.gt = self
    // Postgres, not a permissive stub: a NUL anywhere in the batch is rejected
    // by the server, and the rejection lands on the whole UPSERT — which is
    // exactly how one bad page took the entire material's indexing down.
    c.upsert = async (rows: Record<string, unknown>[]) => {
      upserts.push(...rows)
      if (JSON.stringify(rows).includes('\\u0000')) {
        return { error: { message: 'unsupported Unicode escape sequence' } }
      }
      return { error: null }
    }
    c.delete = () => {
      deletes.push(table)
      return c
    }
    c.single = async () => ({ data: { course_id: 'c1', courses: { code: 'CS584', title: 'NLP' } }, error: null })
    c.maybeSingle = async () => ({
      data:
        table === 'module_items'
          ? {
              id: ITEM,
              title: 'Lecture 6',
              module_id: 'mod-1',
              content: { filePath, ...(topics ? { topics } : {}) },
              modules: { id: 'mod-1', title: 'Week 6', section_id: SECTION },
            }
          : null,
      error: null,
    })
    c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
    return c
  }
  return {
    deletes,
    upserts,
    ctx: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adminDb: { from: (t: string) => chain(t) } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      job: { institution_id: 'inst-1', section_id: SECTION } as any,
      signal: new AbortController().signal,
      reportProgress: async () => {},
    },
  }
}

beforeEach(() => {
  pdfText.value = 'Attention is all you need'
  loadRenderablePdf.mockReset()
  upsertMaterialPageVectors.mockReset()
  deleteMaterialVectors.mockReset()
  deleteMaterialVectors.mockResolvedValue(7)
  storeTopicPageAnchors.mockClear()
})

describe('embed_material — re-anchoring the reference rail', () => {
  it('re-anchors the topics of the material it just indexed', async () => {
    /* Extraction and embedding are enqueued independently at upload, so on a
       first upload extraction usually finishes with no pages in the index yet
       and writes no anchors. If this job did not redo the match, that material
       would never get a rail — and a REPLACED file would keep anchors matched
       against the previous upload's pages. `expectIndexed` is the difference:
       this caller knows the pages are there, so an empty result is a broken
       matcher rather than a race, and gets logged as an error. */
    loadRenderablePdf.mockResolvedValue(Buffer.from('%PDF-'))
    const { ctx } = ctxFor('sec-1/lecture-6.pdf', ['Attention', 'Positional encoding'])

    await embedMaterialPipeline.run({ moduleItemId: ITEM }, ctx)

    expect(storeTopicPageAnchors).toHaveBeenCalledTimes(1)
    expect(storeTopicPageAnchors.mock.calls[0][1]).toMatchObject({
      institutionId: 'inst-1',
      sectionId: SECTION,
      moduleItemId: ITEM,
      topics: ['Attention', 'Positional encoding'],
      expectIndexed: true,
    })
  })

  it('does not re-anchor a material whose vectors it just removed', async () => {
    // A video has no pages to match against; anchoring here would either write
    // nothing or, worse, match topics against another material's vectors.
    const { ctx } = ctxFor('sec-1/lecture-recording.mp4', ['Attention'])

    await embedMaterialPipeline.run({ moduleItemId: ITEM }, ctx)

    expect(deleteMaterialVectors).toHaveBeenCalled()
    expect(storeTopicPageAnchors).not.toHaveBeenCalled()
  })

  it('skips the re-anchor when extraction has not produced topics yet', async () => {
    // The other half of the race: this job won. There is nothing to match, and
    // the extraction job will run the same anchor step when it finishes.
    loadRenderablePdf.mockResolvedValue(Buffer.from('%PDF-'))
    const { ctx } = ctxFor('sec-1/lecture-6.pdf')

    await embedMaterialPipeline.run({ moduleItemId: ITEM }, ctx)

    expect(upsertMaterialPageVectors).toHaveBeenCalled()
    expect(storeTopicPageAnchors).not.toHaveBeenCalled()
  })
})

describe('embed_material — which sources get indexed', () => {
  it('indexes a Word document through the cached conversion', async () => {
    loadRenderablePdf.mockResolvedValue(Buffer.from('%PDF-'))
    const { ctx } = ctxFor('sec-1/handout.docx')

    await embedMaterialPipeline.run({ moduleItemId: ITEM }, ctx)

    // Text extraction would have dropped this file's figures and tables; the
    // converter gives it real page images like any other lecture.
    expect(loadRenderablePdf).toHaveBeenCalledWith(expect.anything(), 'sec-1/handout.docx')
    expect(upsertMaterialPageVectors).toHaveBeenCalled()
  })

  it('indexes a PPTX deck through the cached conversion', async () => {
    loadRenderablePdf.mockResolvedValue(Buffer.from('%PDF-'))
    const { ctx } = ctxFor('sec-1/lecture-6.pptx')

    const out = await embedMaterialPipeline.run({ moduleItemId: ITEM }, ctx)

    // The deck reached the embedding path, not the "remove its vectors" path.
    expect(loadRenderablePdf).toHaveBeenCalledWith(expect.anything(), 'sec-1/lecture-6.pptx')
    expect(upsertMaterialPageVectors).toHaveBeenCalled()
    expect(out.summary).not.toMatch(/removed/i)
  })

  it('still indexes a plain PDF', async () => {
    loadRenderablePdf.mockResolvedValue(Buffer.from('%PDF-'))
    const { ctx } = ctxFor('sec-1/notes.pdf')

    await embedMaterialPipeline.run({ moduleItemId: ITEM }, ctx)

    expect(upsertMaterialPageVectors).toHaveBeenCalled()
  })

  it('drops the vectors of a material it cannot turn into pages', async () => {
    // A video is a real file with no pages at all — nothing to render, so
    // anything indexed from an earlier upload has to go. (Word and Excel are
    // NOT this case: LibreOffice paginates them, so they index like a deck.)
    const { ctx } = ctxFor('sec-1/lecture-recording.mp4')

    const out = await embedMaterialPipeline.run({ moduleItemId: ITEM }, ctx)

    expect(loadRenderablePdf).not.toHaveBeenCalled() // rejected before any download
    expect(deleteMaterialVectors).toHaveBeenCalled()
    expect(upsertMaterialPageVectors).not.toHaveBeenCalled()
    expect(out.summary).toMatch(/removed/i)
  })

  it('fails loudly when the source file is missing, instead of dropping vectors', async () => {
    // null = the row claims a file that storage does not have. Treating that as
    // "not embeddable" would delete a material's vectors on a transient storage
    // fault and report success, so the job could never retry its way back.
    loadRenderablePdf.mockResolvedValue(null)
    const { ctx } = ctxFor('sec-1/lecture-6.pptx')

    await expect(embedMaterialPipeline.run({ moduleItemId: ITEM }, ctx)).rejects.toThrow(/download failed/i)
    expect(deleteMaterialVectors).not.toHaveBeenCalled()
  })

  it('retries — never drops — when a convertible deck fails to convert', async () => {
    /* The extension already passed isRenderableSource, so 'unsupported' here
       cannot mean "wrong file type": it means LibreOffice did not run or did
       not finish — a missing binary, a timeout, a non-zero exit. Those are
       transient, and a memory-pressured instance re-embedding an already
       indexed deck would otherwise delete its vectors and report success, so
       nothing would ever retry it back. */
    loadRenderablePdf.mockResolvedValue('unsupported')
    const { ctx } = ctxFor('sec-1/lecture-6.ppt')

    await expect(embedMaterialPipeline.run({ moduleItemId: ITEM }, ctx)).rejects.toThrow(/could not render/i)
    expect(deleteMaterialVectors).not.toHaveBeenCalled()
  })

  it('refuses a file path outside the job section, and never reads it', async () => {
    /* content.filePath is professor-writable and the update schema takes any
       string, so an item can name another tenant's key. For a deck the load
       path WRITES (it caches the converted PDF beside the original with the
       admin client) — so reading first and checking later would already have
       dropped a file into someone else's prefix. */
    const { ctx } = ctxFor('some-other-section/lecture-6.pptx')

    const out = await embedMaterialPipeline.run({ moduleItemId: ITEM }, ctx)

    expect(loadRenderablePdf).not.toHaveBeenCalled()
    expect(upsertMaterialPageVectors).not.toHaveBeenCalled()
    expect(out.summary).toMatch(/outside its section/i)
  })

  it('refuses a path that climbs out of the section prefix', async () => {
    const { ctx } = ctxFor('sec-1/../other-section/lecture-6.pptx')

    const out = await embedMaterialPipeline.run({ moduleItemId: ITEM }, ctx)

    expect(loadRenderablePdf).not.toHaveBeenCalled()
    expect(out.summary).toMatch(/outside its section/i)
  })
})

describe('embed_material — hostile page text', () => {
  it('strips a NUL from the text layer so one bad page cannot fail the material', async () => {
    // A real CS584 PDF carries U+0000 in its text layer. Postgres rejects NUL in
    // text and jsonb, and the rejection hits the BATCH upsert — so before the
    // sanitisation, one page threw "unsupported Unicode escape sequence" and
    // took every page in that batch with it, then retried into a hard fail.
    // The stub upsert above rejects NUL the way the server does, so removing
    // stripNul() from the pipeline makes this run throw, not merely look untidy.
    loadRenderablePdf.mockResolvedValue(Buffer.from('%PDF-'))
    pdfText.value = `Self-\u0000attention\u0000`
    const { ctx, upserts } = ctxFor('sec-1/notes.pdf')

    const out = await embedMaterialPipeline.run({ moduleItemId: ITEM }, ctx)

    // Sanitised, not dropped — the page is still indexed and still readable.
    expect(upserts[0]).toMatchObject({ page_number: 1, content: 'Self-attention', status: 'indexed' })
    expect(out.result).toMatchObject({ embedded: 1, failed: 0 })
  })
})
