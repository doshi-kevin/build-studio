// Shared utilities for SkillSignal → Scholera migration.
// Provides: local DB client (skillsignal schema), Supabase admin client,
// deterministic UUID generation, ID map persistence, and logging helpers.

import { createClient } from '@supabase/supabase-js'
import { v5 as uuidv5 } from 'uuid'
import * as fs from 'fs'
import * as path from 'path'

// ── Supabase Admin Client (local or prod, from .env.local) ─────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321'
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!SUPABASE_SERVICE_KEY) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY not set. Source .env.local first.')
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ── pg client for skillsignal schema (same local postgres) ──────────────────
import pg from 'pg'
const { Pool } = pg

const LOCAL_DB_URL = process.env.SS_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
export const ssPool = new Pool({
  connectionString: LOCAL_DB_URL,
  options: '-c search_path=skillsignal',
})

// Helper to query the skillsignal schema
export async function ssQuery<T extends pg.QueryResultRow>(
  sql: string,
  params?: (string | number | boolean | null)[]
): Promise<T[]> {
  const result = await ssPool.query<T>(sql, params)
  return result.rows
}

// ── Deterministic UUIDs via uuid v5 ─────────────────────────────────────────
// Namespace derived from project name — same input always produces same UUID
const NAMESPACE = uuidv5('skillsignal-scholera-migration', uuidv5.DNS)

export function deterministicUuid(prefix: string, id: string | number): string {
  return uuidv5(`${prefix}-${id}`, NAMESPACE)
}

// Convenience helpers
export const questionUuid = (ssId: number) => deterministicUuid('question', ssId)
export const choiceUuid = (ssQid: number, ssChoiceId: number) => deterministicUuid('choice', `${ssQid}-${ssChoiceId}`)
export const quizUuid = (ssId: number) => deterministicUuid('quiz', ssId)
export const attemptUuid = (ssSittingId: number) => deterministicUuid('attempt', ssSittingId)
export const sectionUuid = () => deterministicUuid('section', 'cs584b-spring2026')

// ── ID Map Persistence ──────────────────────────────────────────────────────
// User IDs are NOT deterministic (Supabase Auth assigns them), so we persist them.

const ID_MAP_PATH = path.join(__dirname, 'ss-id-map.json')

export interface IdMapData {
  generatedAt: string
  sectionId: string
  professorId: string
  users: Record<string, string> // SS user id (string) → Scholera profile UUID
}

export function saveIdMap(data: IdMapData): void {
  fs.writeFileSync(ID_MAP_PATH, JSON.stringify(data, null, 2))
  log(`ID map saved to ${ID_MAP_PATH}`)
}

export function loadIdMap(): IdMapData {
  if (!fs.existsSync(ID_MAP_PATH)) {
    throw new Error(`ID map not found at ${ID_MAP_PATH}. Run migrate-ss-phase0.ts first.`)
  }
  return JSON.parse(fs.readFileSync(ID_MAP_PATH, 'utf-8'))
}

// ── Logging ─────────────────────────────────────────────────────────────────
export function log(msg: string): void {
  console.log(`  [MIGRATE] ${msg}`)
}

export function logPhase(phase: string): void {
  console.log(`\n━━━ ${phase} ━━━`)
}

export function logOk(msg: string): void {
  console.log(`  ✓ ${msg}`)
}

export function logWarn(msg: string): void {
  console.log(`  ⚠ ${msg}`)
}

export function logError(msg: string): void {
  console.error(`  ✗ ${msg}`)
}

// ── Constants ───────────────────────────────────────────────────────────────
export const PROF_ZHU_SCHOLERA_ID = 'd53f068b-cd81-4f22-bf85-fd8ced81be7f'
export const SS_COURSE_ID = 2 // SkillSignal NLP course
export const NLP_COURSE_ID_SCHOLERA = '8f728d1f-f239-4b03-acf1-212064da34d4' // Scholera courses.id for code '506'

// ── Cleanup ─────────────────────────────────────────────────────────────────
export async function cleanup(): Promise<void> {
  await ssPool.end()
}
