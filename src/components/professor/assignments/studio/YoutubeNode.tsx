/**
 * StudioYoutube — the TipTap YouTube node wrapped in a React NodeView with BlockChrome, so an
 * embedded video is a proper, selectable block with a hover Delete/Duplicate toolbar (the bare
 * extension renders an atom with no chrome, which made videos impossible to delete and left the
 * cursor stuck around them).
 *
 * - Valid src → a responsive 16:9 embed (privacy-enhanced youtube-nocookie host).
 * - Missing/blank src → a "Video unavailable" placeholder instead of crashing (the extension's
 *   own renderHTML throws on a null src).
 * renderHTML is kept for serialization / PDF export; the NodeView only drives the editor UI.
 *
 * Type: Client Component
 */
'use client'

import { useCallback, useEffect, useState } from 'react'
import Youtube from '@tiptap/extension-youtube'
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { VideoOff } from 'lucide-react'
import { BlockChrome } from './shared/BlockChrome'
import { youtubeVideoId } from './athena-document-blocks'
import { verifyYoutubeVideo, type YoutubeCheck } from './actions'
import { useAthenaDock } from '@/components/professor/assignments/athena/AssignmentAthenaDock'

/**
 * Extract an embeddable URL from a YouTube watch / short / embed link, or null if it isn't one.
 *
 * The id rule lives in athena-document-blocks (pure, client-safe) because Athena's block BUILDER
 * needs the identical test. It previously lived only here, while the builder accepted any
 * non-empty string — so the builder happily produced blocks this renderer could only draw as
 * "Video unavailable", and counted them as inserted.
 */
function toEmbedUrl(src: unknown): string | null {
  const id = youtubeVideoId(src)
  return id ? `https://www.youtube-nocookie.com/embed/${id}` : null
}

/**
 * The one box for "there is a link here and it doesn't work", in both flavours.
 *
 * `canEdit` is load-bearing, not cosmetic. This NodeView is ALSO rendered by DocumentReadOnly,
 * which is the STUDENT view and the "View as student" preview — so telling the reader to replace
 * the link would issue an instruction to someone with no toolbar and no responsibility for the
 * mistake. Readers get the description only; the fix is addressed to the author.
 *
 * `malformed` and `missing` share this box deliberately. They used to differ wildly — a bare
 * dashed "Video unavailable" versus a full explanation — and the dashed one was the LESS
 * informative state for the MORE diagnosable problem. It is also where every pre-fix Athena
 * artifact lands, since the builder used to accept any non-empty string, so it is exactly the
 * population this change exists to surface.
 */
function BadVideo({
  src,
  canEdit,
  reason,
}: {
  src: string
  canEdit: boolean
  reason: 'missing' | 'malformed'
}) {
  const { entitled: athenaEntitled } = useAthenaDock()
  return (
    // Warning tokens, not destructive: nothing is broken in the document, one link is.
    <div className="mx-auto flex min-h-24 max-w-2xl flex-col items-start gap-1 rounded-xl border border-warning/40 bg-warning-muted px-4 py-3 text-sm text-warning-muted-foreground">
      <span className="flex items-center gap-2 font-medium">
        <VideoOff className="h-4 w-4 shrink-0" aria-hidden="true" />
        {/* NOT "this video doesn't exist". oEmbed also 404s for a PRIVATE video, so the stronger
            claim would falsely accuse a professor about a link they added deliberately and can
            see themselves — and one false accusation makes every future warning ignorable. */}
        {reason === 'missing' ? 'This video isn’t available on YouTube' : 'This isn’t a YouTube link'}
      </span>
      <span className="text-xs">
        {reason === 'missing'
          ? 'YouTube doesn’t return this video — the link may be wrong, or the video was removed or set to private.'
          : 'The address here isn’t a YouTube video link, so there is nothing to play.'}
        {/* Only the author can act, so only the author is asked to. Naming Athena as a
            possible cause is itself an Athena-shaped affordance — drop it for a school
            that doesn't have her, since the instruction underneath still applies either way. */}
        {canEdit
          ? athenaEntitled
            ? ' If Athena added it, replace it with a link you’ve opened yourself.'
            : ' Replace it with a link you’ve opened yourself.'
          : ''}
      </span>
      {/* Shown to the AUTHOR only: it is the identifier of the broken thing and the only way to
          tell a fabricated link from a removed video. To a student it is pure noise.
          font-mono rather than reduced opacity — the token's contrast is measured, and
          opacity-80 blended it back under the 4.5:1 line it was chosen to clear. */}
      {canEdit && <span className="wrap-anywhere font-mono text-xs">{src}</span>}
    </div>
  )
}

function YoutubeNodeView({ node, deleteNode, getPos, selected, editor }: NodeViewProps) {
  const src = node.attrs.src
  const hasSrc = typeof src === 'string' && src.trim().length > 0
  const embed = toEmbedUrl(src)
  const videoId = youtubeVideoId(src)

  /**
   * Does this video actually EXIST?
   *
   * A well-formed id is not a real video. Athena was observed grounding a real lesson's
   * existence and then inventing `watch?v=pD4UqjS3W2A` for it — which passes every offline
   * check, so the professor got a player that YouTube renders as unavailable INSIDE a
   * cross-origin iframe we cannot inspect. Hence a server round-trip to oEmbed.
   *
   * Starts at 'unknown', which renders the embed unchanged — so the normal case (a real video)
   * never flashes a warning, and a slow or failed check degrades to exactly today's behaviour.
   */
  // Stored WITH the id it describes, and read back only for the current id. That is what makes
  // a stale verdict impossible when src changes — without it the effect had to synchronously
  // reset to 'unknown' on every id change, which is a setState-in-render-phase-effect.
  const [checked, setChecked] = useState<{ id: string; status: YoutubeCheck['status'] } | null>(null)
  const check = checked?.id === videoId ? checked.status : 'unknown'

  useEffect(() => {
    if (!videoId) return
    let alive = true
    verifyYoutubeVideo(videoId)
      .then((r) => {
        if (alive) setChecked({ id: videoId, status: r.status })
      })
      // A rejected action is "we don't know", never "it's broken" — same rule as the action's
      // own unknown branch. Silent on purpose: this is a background check on someone's page.
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [videoId])

  const handleDuplicate = useCallback(() => {
    if (typeof getPos !== 'function') return
    editor.chain().insertContentAt(getPos() + node.nodeSize, node.toJSON()).run()
  }, [editor, getPos, node])

  return (
    <NodeViewWrapper>
      <BlockChrome
        editor={editor}
        selected={selected}
        onDelete={deleteNode}
        onDuplicate={handleDuplicate}
      >
        {embed && check !== 'missing' ? (
          <div className="relative mx-auto aspect-video w-full max-w-2xl overflow-hidden rounded-xl border border-border">
            <iframe
              src={embed}
              title="YouTube video"
              className="absolute inset-0 h-full w-full"
              allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        ) : hasSrc ? (
          <BadVideo src={String(src)} canEdit={editor.isEditable} reason={embed ? 'missing' : 'malformed'} />
        ) : (
          // No src at all — nothing to explain and nothing to show.
          <div className="mx-auto flex min-h-24 max-w-2xl items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
            Video unavailable
          </div>
        )}
      </BlockChrome>
    </NodeViewWrapper>
  )
}

export const StudioYoutube = Youtube.extend({
  addNodeView() {
    return ReactNodeViewRenderer(YoutubeNodeView)
  },
  // Kept for serialization / PDF export. Guards a null src (the base renderHTML throws on it).
  renderHTML(props) {
    const src = props.HTMLAttributes?.src
    if (typeof src !== 'string' || !src.trim()) {
      return ['div', { 'data-youtube-video': '', class: 'studio-youtube flex min-h-24 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground' }, 'Video unavailable']
    }
    return this.parent?.(props) ?? ['div', { 'data-youtube-video': '' }]
  },
})
