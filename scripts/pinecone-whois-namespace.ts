// Translate Pinecone namespaces (inst_{uuid}__sec_{uuid}) into human names.
//
// The dashboard shows opaque UUIDs by design — vector metadata stays opaque
// ids only (names live in Postgres, the source of truth, so they can never go
// stale in a second store). When you need to know WHICH institution/section a
// namespace is, ask Postgres:
//
//   npx tsx scripts/pinecone-whois-namespace.ts                 # all namespaces
//   npx tsx scripts/pinecone-whois-namespace.ts <namespace>     # just one
//
// Needs PINECONE_API_KEY, PINECONE_INDEX_MATERIALS, NEXT_PUBLIC_SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY (read from .env.local automatically).

import path from 'path'
import { config as loadEnv } from 'dotenv'
import { Pinecone } from '@pinecone-database/pinecone'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: path.resolve(__dirname, '../.env.local') })

const NAMESPACE_RE = /^inst_([0-9a-f-]{36})__sec_([0-9a-f-]{36})$/i

async function main() {
  const { PINECONE_API_KEY, PINECONE_INDEX_MATERIALS, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } =
    process.env
  if (!PINECONE_API_KEY || !PINECONE_INDEX_MATERIALS || !NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing env — needs PINECONE_API_KEY, PINECONE_INDEX_MATERIALS, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
  }

  let namespaces: { name: string; records?: number }[]
  const arg = process.argv[2]
  if (arg) {
    namespaces = [{ name: arg }]
  } else {
    const pc = new Pinecone({ apiKey: PINECONE_API_KEY })
    const stats = await pc.index(PINECONE_INDEX_MATERIALS).describeIndexStats()
    namespaces = Object.entries(stats.namespaces ?? {}).map(([name, s]) => ({
      name,
      records: s.recordCount,
    }))
    if (namespaces.length === 0) {
      console.log(`Index "${PINECONE_INDEX_MATERIALS}" has no namespaces yet.`)
      return
    }
  }

  const db = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  for (const ns of namespaces) {
    const m = ns.name.match(NAMESPACE_RE)
    if (!m) {
      console.log(`${ns.name} — not a materials namespace (unexpected shape)`)
      continue
    }
    const [, institutionId, sectionId] = m
    const [{ data: inst }, { data: section }] = await Promise.all([
      db.from('institutions').select('name').eq('id', institutionId).maybeSingle(),
      db
        .from('course_sections')
        .select('section_code, semester, year, courses(code, title)')
        .eq('id', sectionId)
        .maybeSingle(),
    ])
    const course = Array.isArray(section?.courses) ? section?.courses[0] : section?.courses
    const label = [
      inst?.name ?? `unknown institution ${institutionId}`,
      course ? `${course.code} ${course.title}` : `unknown section ${sectionId}`,
      section ? `§${section.section_code} ${section.semester} ${section.year}` : '',
    ]
      .filter(Boolean)
      .join(' → ')
    console.log(`${ns.name}\n  ${label}${ns.records !== undefined ? ` — ${ns.records} vector(s)` : ''}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
