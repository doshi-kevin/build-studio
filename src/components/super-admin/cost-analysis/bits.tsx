/**
 * Small server-safe building blocks shared by the Cost Analysis overview and
 * institution detail pages (Kpi / Section / Table follow the shapes the old
 * ai-costs page established; SourceBadge labels a provider figure's
 * provenance: billed / plan / computed).
 */

export function usd(n: number): string {
  if (n === 0) return '$0.00'
  return `$${n.toFixed(n < 1 ? 4 : 2)}`
}

export function num(n: number): string {
  return n.toLocaleString('en-US')
}

export const FEATURE_LABELS: Record<string, string> = {
  professor_assistant: 'Athena (Professor Assistant)',
  assignment_assistant: 'Assignment Assistant',
  quiz_assistant: 'Quiz Assistant (Athena)',
  athena_frontier: 'Athena Frontier Mode',
  student_assistant: 'Athena (Student)',
  // The retired full-context tutor. Kept so its historical rows still read as
  // English — its cost per message describes a design we deleted, so it is a
  // separate line from student_assistant rather than the same one renamed.
  ai_tutor: 'AI Tutor (retired)',
  quiz_generation: 'Quiz Generation',
  quiz_concepts: 'Quiz Concept Extraction',
  quiz_answerability: 'Quiz Answerability Check',
  quiz_redundancy: 'Quiz Redundancy Check',
  quiz_topic_consistency: 'Quiz Topic Consistency Check',
  quiz_dedup_embedding: 'Quiz Dedup (Embeddings)',
  quiz_grading: 'Quiz Grading',
  walkthrough_turn: 'Walkthrough Tutor Turns',
  roadmap_node_check: 'Roadmap Node Checks',
  topic_extraction: 'Topic Extraction',
  topic_hierarchy: 'Topic Hierarchy',
  topic_parent: 'Topic Placement',
  project_phases: 'Project Phases',
  live_quiz_generation: 'Live Quiz Generation',
  lecture_summary: 'Catch-Me-Up Summary',
  session_report: 'Session Report',
  class_insights_flashcards: 'Flashcards (Class Insights)',
  class_insights_practice_quiz: 'Practice Quiz (Class Insights)',
  primer_script: 'Primer Script',
  formula_extraction: 'Formula Extraction (Vision)',
  rubric_generation: 'Rubric Generation',
  reference_links: 'Reference Link Suggestions',
  outcome_alignment: 'Outcome Alignment',
  conversation_title: 'Conversation Titles',
  announcement_rewrite: 'Announcement Rewrite (Athena)',
  // material_embedding is Gemini token spend (category AI/LLM), NOT a Pinecone
  // charge — the "Vector Store" rows below are what lands on the Pinecone bill.
  material_embedding: 'Material Embedding (tokens)',
  material_search: 'Material Search (Query Embedding)',
  content_embedding: 'Content Embedding (Reference Rail)',
  material_query: 'Vector Store — Queries',
  material_upsert: 'Vector Store — Writes',
  material_delete: 'Vector Store — Deletes',
  material_list: 'Vector Store — Listings',
  search_grounding: 'Google Search Grounding',
  live_transcription: 'Live Transcription',
  primer_tts: 'Primer Audio (TTS)',
  verbal_tts: 'Verbal Assessment Audio (TTS)',
  verbal_stt: 'Verbal Assessment Transcription',
  email: 'Email',
}
export const featureLabel = (f: string) => FEATURE_LABELS[f] ?? f

export function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
    </div>
  )
}

export function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {sub ? <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p> : null}
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">{children}</div>
    </section>
  )
}

export function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    // The Section card clips (overflow-hidden for rounded corners); this inner
    // wrapper lets wide tables scroll horizontally on narrow viewports.
    <div className="overflow-x-auto">
      <TableInner head={head} rows={rows} />
    </div>
  )
}

function TableInner({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
          {head.map((h, i) => (
            <th key={i} className={`px-4 py-2.5 font-medium ${i === 0 ? '' : 'text-right'}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, ri) => (
          <tr key={ri} className="border-b border-border last:border-0">
            {r.map((c, ci) => (
              <td key={ci} className={`px-4 py-2.5 ${ci === 0 ? 'text-foreground' : 'text-right tabular-nums text-muted-foreground'}`}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const SOURCE_STYLES: Record<string, string> = {
  billed: 'bg-success-muted text-success-muted-foreground',
  plan: 'bg-muted text-muted-foreground',
  computed: 'bg-warning-muted text-warning-muted-foreground',
}
const SOURCE_TITLES: Record<string, string> = {
  billed: 'Provider-reported billing data',
  plan: 'Fixed plan price — provider has no usage/billing API',
  computed: 'Our metered count × published pricing',
}

export function SourceBadge({ source }: { source: string }) {
  return (
    <span
      title={SOURCE_TITLES[source]}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${SOURCE_STYLES[source] ?? 'bg-muted text-muted-foreground'}`}
    >
      {source}
    </span>
  )
}
