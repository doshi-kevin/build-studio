// Message rendering for the Athena shell chat — markdown, numbered citation
// chips, sources list, and inline asset images. The citation machinery moved
// here unchanged from the retired StudentAITutor; the visual language matches
// the professor-side Athena panel: assistant turns are plain full-width prose
// (no avatar), user turns are right-aligned primary bubbles.

'use client'

import { useMemo, useState, useCallback } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { Copy, Check, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { toast } from 'sonner'
import type { UIMessage } from 'ai'
import { AttachmentChip, chipFromFilePart } from '@/components/shared/athena/AttachmentChip'
import { parseCitations, matchCitationDoc, citationPages, CITATION_RE } from '@/lib/extraction/citation'
import { parseAssetRef } from '@/lib/extraction/assets'
import { normalizeMathDelimiters } from '@/lib/markdown/math'
import { cn } from '@/lib/utils'
import { balanceStreamingBlocks } from '@/lib/ai/streaming-blocks'

/** Published items Athena can cite, used to map a [Title, page N] citation to a previewable doc. */
export interface TutorDocument {
  id: string
  title: string
  fileType: string
}

/** A citation preview the user opened (resolved to a specific item + page). */
export interface PreviewTarget {
  itemId: string
  page: number
  title: string
  /** The citation was the professor's own words (N1) — the preview leads with
   *  the transcript and keeps the slide underneath. */
  spoken?: boolean
  /** How the ANSWER named the source (the deck title), which is what finds the
   *  transcript. `title` above is the material the chip resolved to — the same
   *  words only when the deck was promoted into the modules. */
  citedTitle?: string
}

/** Extract the text content from a UIMessage's parts array. */
export function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/** A file part as the bubble needs it: what to call it, and where it lives. */
export interface MessageAttachment {
  filename?: unknown
  url?: unknown
}

/** The file parts of a message — what the student attached to that turn. */
export function getMessageAttachments(message: UIMessage): MessageAttachment[] {
  return message.parts.filter((p): p is UIMessage['parts'][number] & MessageAttachment => p.type === 'file')
}

/**
 * Swap `![caption](asset://<itemId>:<kind>:<page>:<idx>)` images for the
 * authorized render endpoint (which re-validates the ref against the stored
 * extraction and crops the page region). Malformed refs are stripped — a
 * hallucinated asset must never leave a broken image in the chat.
 *
 * The leading `!` is optional: a model that drops it writes a LINK to
 * `asset://…`, which markdown sanitizes to `href=""` — a chip-less, image-less
 * dead end that reloads the page when clicked. Treat both forms as the image
 * the prompt asked for.
 */
function resolveAssetImages(content: string): string {
  return content
    .replace(/!?\[([^\]]*)\]\(asset:\/\/([^)\s]+)\)/g, (_m, alt: string, ref: string) => {
      const parsed = parseAssetRef(ref)
      if (!parsed) return ''
      return `![${alt}](/api/extraction/page?item=${parsed.itemId}&asset=${parsed.kind}:${parsed.page}:${parsed.idx})`
    })
    // The prompt forbids it, but strip any parroted internal [ASSET ...] tag text.
    .replace(/\s*\[ASSET [^\]]{1,120}\]/gi, '')
}

/** The numbered citation box. Used inline in the prose and again in the Sources
 *  list — one const rather than two copies, because looking identical in both
 *  places is the point, and drift would be the bug. */
const CITE_BOX =
  'athena-cite inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary/8 px-1 text-xs font-semibold'

/** A citation with its matched (previewable) document, shared by the inline
 *  chips and the Sources list so both use the same 1..n numbering. `title` is
 *  stored STRIPPED of the "(spoken)" suffix — the suffix is provenance, not
 *  identity, and carrying it in the title made one deck count as two sources
 *  and clipped the provenance off at the row's truncation edge. */
interface NumberedSource {
  title: string
  page: number
  /** From the professor's mouth (N1) — the marker was `[Title (spoken), slide N]`. */
  spoken: boolean
  doc?: TutorDocument
}

/** The "(spoken)" provenance suffix a transcript citation carries (N1). */
const SPOKEN_RE = /\s*\(spoken\)\s*$/i

/** What a citation opens in the preview panel — ONE builder, because the inline
 *  chip and the Sources list below the answer must agree. They didn't: the list
 *  dropped the spoken flag, so a row reading "said in class" opened the slide
 *  with none of the words it had just promised. `null` means nothing to preview,
 *  which is also what disables the control. */
function previewFor(s: NumberedSource): PreviewTarget | null {
  if (!s.doc) return null
  return { itemId: s.doc.id, page: s.page, title: s.doc.title, spoken: s.spoken, citedTitle: s.title }
}

/** One key shape for both sides of the chip numbering. The spoken flag stays
 *  IN the key: a slide cited from the deck and the same slide cited from what
 *  was said are two pieces of evidence and must keep two chips. */
const sourceKey = (rawTitle: string, page: number): string => {
  const spoken = SPOKEN_RE.test(rawTitle)
  return `${rawTitle.replace(SPOKEN_RE, '').trim().toLowerCase()}#${page}#${spoken ? 's' : 'p'}`
}

/**
 * Replace inline `[Title, page N]` tokens with numbered chip links
 * (`[n](cite:n)`) so the prose reads cleanly — the number matches the
 * Sources list below the answer. Unmatched tokens are left as-is.
 *
 * A multi-page token (`[Title, page 44, 51]`) becomes one chip per page, since
 * `parseCitations` numbered each page separately.
 */
function citationsToChips(content: string, sources: NumberedSource[]): string {
  const numberFor = new Map(
    sources.map((s, i) => [`${s.title.toLowerCase()}#${s.page}#${s.spoken ? 's' : 'p'}`, i + 1]),
  )
  return content.replace(CITATION_RE, (full, title: string, pageList: string) => {
    const numbers = citationPages(pageList).map((p) => numberFor.get(sourceKey(title, p)))
    // All-or-nothing: a partially resolved list would render "[undefined]".
    return numbers.every(Boolean) ? numbers.map((n) => `[${n}](cite:${n})`).join('') : full
  })
}

/** Allow our internal `cite:` links through react-markdown's URL sanitizer. */
function urlTransform(url: string): string {
  return url.startsWith('cite:') ? url : defaultUrlTransform(url)
}

/** react-markdown hands each custom renderer the mdast `node` alongside the HTML
 *  props. It has to come off before the rest is spread onto an element, or it
 *  lands in the DOM as `node="[object Object]"`. */
interface MarkdownExtraProps {
  node?: unknown
}

function domProps<T extends object>(props: T & MarkdownExtraProps): T {
  const rest = { ...props }
  delete rest.node
  return rest
}

/** Inline image in an answer. Shows a pulse placeholder while the page region
 *  renders server-side (a cold PPTX→PDF conversion can take seconds), and
 *  hides itself entirely if the asset fails to load. Spans (not divs):
 *  ReactMarkdown places images inside <p>, where a div is invalid nesting. */
function MarkdownImage(allProps: React.ImgHTMLAttributes<HTMLImageElement> & MarkdownExtraProps) {
  const props = domProps(allProps)
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading')
  // A cached image can finish loading BEFORE React attaches the load listener
  // (the event is then never delivered) — check completion state when the
  // element mounts, via a callback ref.
  const checkAlreadyComplete = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete) setStatus(img.naturalWidth > 0 ? 'loaded' : 'failed')
  }, [])
  if (status === 'failed' || !props.src) return null
  return (
    <>
      {status === 'loading' && (
        <span className="my-2 block h-40 max-w-sm animate-pulse rounded-xl border border-border bg-background/60" />
      )}
      {/* NOT loading="lazy": the img is display-hidden until it loads, and a
          hidden lazy image never intersects the viewport → never fetches. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        {...props}
        ref={checkAlreadyComplete}
        alt={props.alt || 'Course material visual'}
        className={`my-2 max-h-80 max-w-full rounded-xl border border-border object-contain bg-background ${status === 'loaded' ? '' : 'hidden'}`}
        onLoad={() => setStatus('loaded')}
        onError={() => setStatus('failed')}
      />
    </>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Failed to copy')
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

export function ChatMessage({
  role,
  content,
  attachments = [],
  documents,
  onOpenPreview,
  streaming = false,
}: {
  role: string
  content: string
  /** Files the student attached to this turn (user messages only). */
  attachments?: MessageAttachment[]
  documents: TutorDocument[]
  onOpenPreview: (target: PreviewTarget) => void
  /** True only for the answer currently arriving — see the withholding note below. */
  streaming?: boolean
}) {
  const isUser = role === 'user'
  const sources = useMemo<NumberedSource[]>(
    () =>
      isUser
        ? []
        : parseCitations(content).map((c) => {
            // A spoken citation (N1) is "[Deck title (spoken), slide N]". The
            // suffix is provenance, so it moves onto `spoken` and the title is
            // stored clean: the doc match then still opens the slide preview
            // (the deck is often a promoted material), one deck cited both
            // ways counts as one source, and the row's tail — not the
            // truncating title — carries "said in class".
            const spoken = SPOKEN_RE.test(c.title)
            const title = c.title.replace(SPOKEN_RE, '').trim()
            return { title, page: c.page, spoken, doc: matchCitationDoc(title, documents) }
          }),
    [isUser, content, documents],
  )
  /* Half-written `$$…` and fenced blocks crawl across the screen as raw markup
     until their closing delimiter arrives, so the balancer withholds the unclosed
     tail WHILE the answer streams. It must not run on a settled message: it would
     silently delete the tail of prose that legitimately contains an odd number of
     `$$`. (Merged from main, where the same guard lived at the retired tutor's
     call site; normalizeMathDelimiters fixes delimiter SHAPE, not this.) */
  const rendered = useMemo(() => {
    if (isUser) return content
    const text = streaming ? balanceStreamingBlocks(content) : content
    return citationsToChips(normalizeMathDelimiters(resolveAssetImages(text)), sources)
  }, [isUser, content, sources, streaming])
  const components = useMemo(
    () => ({
      img: MarkdownImage,
      // `cite:n` links become numbered citation chips; real links stay anchors.
      a: (allProps: React.AnchorHTMLAttributes<HTMLAnchorElement> & MarkdownExtraProps) => {
        const props = domProps(allProps)
        const href = props.href ?? ''
        if (!href.startsWith('cite:')) {
          return <a {...props} target="_blank" rel="noreferrer" />
        }
        const source = sources[Number(href.slice(5)) - 1]
        if (!source) return null
        const target = previewFor(source)
        const clickable = !!target
        // A spoken source is a deck slide the student was in the room for —
        // "slide", never "page" (the marker itself says slide).
        const where = `${source.spoken ? 'said in class · slide' : 'page'} ${source.page}`
        return (
          <button
            type="button"
            disabled={!clickable}
            onClick={target ? () => onOpenPreview(target) : undefined}
            title={
              clickable
                ? `${source.title} · ${where}`
                : `${source.title} · ${where} — preview unavailable`
            }
            // ml only: a right margin strands the sentence's period after the
            // chip. Non-previewable chips go neutral rather than opacity-70 —
            // fading the whole chip dropped its ink to ~2.8:1, and "not a link"
            // reads better as a different colour family than as a tired link.
            className={`${CITE_BOX} ml-0.5 -translate-y-0.5 ${
              clickable ? 'hover:bg-primary/20' : 'cursor-default bg-muted text-muted-foreground'
            }`}
          >
            {props.children}
          </button>
        )
      },
    }),
    [sources, onOpenPreview],
  )

  if (isUser) {
    // A file with no question is a whole turn on its own, so the bubble is only
    // drawn when there is something to put in it.
    return (
      <div className="flex flex-col items-end gap-2">
        {attachments.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
            {attachments.map((a, i) => (
              <AttachmentChip key={i} data={chipFromFilePart(a.filename, a.url)} />
            ))}
          </div>
        )}
        {content && (
          <div className="max-w-[85%] whitespace-pre-wrap wrap-break-word rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground">
            {content}
          </div>
        )}
      </div>
    )
  }

  // Assistant turn — plain full-width prose, no avatar (prototype convention).
  return (
    <div className="group min-w-0">
      {/* `athena-streaming` draws the caret as a ::after on the last block, so
          it rides the end of the final line of text. As a sibling <span> it
          landed on its own line (an inline-block after a block element starts
          a new one) and, being :last-child, it stole the mb-0 rule from the
          closing paragraph — which then shifted vertically the moment the
          answer finished. See globals.css. */}
      <div className={cn("prose prose-sm max-w-none wrap-break-word text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 prose-pre:rounded-xl prose-pre:border prose-pre:border-border prose-pre:bg-muted prose-code:font-mono", streaming && "athena-streaming")}>
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={components} urlTransform={urlTransform}>
          {rendered}
        </ReactMarkdown>
      </div>
      <SourcesList sources={sources} onOpenPreview={onOpenPreview} />
      {content.trim().length > 0 && (
        <div className="mt-1 flex items-center opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100">
          <CopyButton text={content} />
        </div>
      )}
    </div>
  )
}

/** Numbered, clickable list of the [Title, page N] citations in an answer.
 *  Numbering matches the inline citation chips (same `sources` array).
 *
 *  Collapsed by default: an answer can cite half a dozen long filenames, and
 *  rendering them all pushed the answer itself out of view. The count in the
 *  trigger is the signal ("this is grounded"); the titles are the detail. */
function SourcesList({
  sources,
  onOpenPreview,
}: {
  sources: NumberedSource[]
  onOpenPreview: (target: PreviewTarget) => void
}) {
  if (sources.length === 0) return null

  // Count documents, not citations. An answer routinely cites six pages of one
  // lecture; labelling that "6 sources" promises breadth the expanded list
  // doesn't have, which is the opposite of what a grounding signal is for.
  // (Titles arrive stripped of "(spoken)", so a deck cited from the slides AND
  // from what was said still counts once.)
  const docCount = new Set(sources.map((s) => s.title.toLowerCase())).size
  // "from class" on the collapsed trigger is the one always-visible copy of the
  // spoken provenance — the expanded rows and tooltips carry the detail.
  const label =
    `${docCount} ${docCount === 1 ? 'source' : 'sources'}` +
    (sources.length > docCount ? ` · ${sources.length} pages` : '') +
    (sources.some((s) => s.spoken) ? ' · from class' : '')

  return (
    <Collapsible className="mt-2">
      {/* Chevron rotation via the same child selector accordion.tsx uses. */}
      <CollapsibleTrigger className="inline-flex items-center gap-1 rounded-xl py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground [&[data-state=open]>svg]:rotate-90">
        <ChevronRight className="h-3.5 w-3.5 transition-transform" aria-hidden />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 flex flex-col items-start gap-1">
        {sources.map((s, i) => {
          const target = previewFor(s)
          const clickable = !!target
          return (
            <button
              key={`${s.title}#${s.page}#${i}`}
              type="button"
              disabled={!clickable}
              onClick={target ? () => onOpenPreview(target) : undefined}
              // Negative margin + padding so the row is a real ~28px target with
              // a visible hit area — these rows are the "go read the source"
              // action, and bare text gave no clue where to aim.
              className={`group/row -mx-1.5 flex max-w-full items-center gap-1.5 rounded-xl px-1.5 py-1 text-left text-xs text-muted-foreground ${
                clickable ? 'hover:bg-muted hover:text-foreground' : 'cursor-default'
              }`}
              title={clickable ? 'Open the cited page' : 'Source not available to preview'}
            >
              <span
                className={`${CITE_BOX} ${clickable ? 'group-hover/row:bg-primary/20' : 'bg-muted text-muted-foreground'}`}
              >
                {i + 1}
              </span>
              <span className="truncate">{s.title}</span>
              {/* Provenance rides the non-truncating tail: a long deck title
                  clips, "said in class" must not. */}
              <span className="shrink-0">· {s.spoken ? `said in class · slide ${s.page}` : `p.${s.page}`}</span>
            </button>
          )
        })}
      </CollapsibleContent>
    </Collapsible>
  )
}
