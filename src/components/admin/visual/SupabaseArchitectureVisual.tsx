'use client'

// Interactive architecture visual showing how Supabase connects to Scholera.
// Displays client architecture, security pipeline, database schema map, and storage buckets.

import { useState, useMemo, useEffect } from 'react'
import { motion, type Variants } from 'framer-motion'
import { SURFACE_ENTER } from '@/lib/motion'
import {
  Database, Shield, Lock, Globe, Server,
  ArrowRight, ArrowDown, Layers, HardDrive,
  Users, BookOpen, MessageSquare, ClipboardCheck,
  FolderKanban, Radio, Calendar, Map, Award,
  Zap, Eye, KeyRound, ShieldCheck,
  Building2, GraduationCap, FileText, Activity,
  type LucideIcon,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Animation variants
// ---------------------------------------------------------------------------

const fadeUp = {
  hidden: { opacity: 0, y: 24, filter: 'blur(4px)' },
  visible: { opacity: 1, y: 0, filter: 'blur(0px)', transition: SURFACE_ENTER },
} as unknown as Variants

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.1, delayChildren: 0.15 } },
} as Variants

// ---------------------------------------------------------------------------
// Data: Supabase client types
// ---------------------------------------------------------------------------

const CLIENTS = [
  {
    id: 'browser',
    name: 'Browser Client',
    file: 'client.ts',
    icon: Globe,
    key: 'Anon Key',
    rls: true,
    description: 'Client components, Realtime subscriptions, login/signup forms',
    usedBy: ['Login & Signup pages', 'Realtime subscriptions', 'Client-side queries'],
    security: 'RLS policies enforce access',
  },
  {
    id: 'server',
    name: 'Server Client',
    file: 'server.ts',
    icon: Server,
    key: 'Anon Key + Cookies',
    rls: true,
    description: 'Server components, server actions, API routes with cookie-based auth',
    usedBy: ['Server Components (SSR)', 'Server Actions', 'API Routes'],
    security: 'RLS + auth cookies',
  },
  {
    id: 'admin',
    name: 'Admin Client',
    file: 'admin.ts',
    icon: ShieldCheck,
    key: 'Service Role Key',
    rls: false,
    description: 'Server-only admin operations that bypass RLS for system-level access',
    usedBy: ['Admin CRUD operations', 'Event logging', 'Dashboard queries'],
    security: '3-layer verification required',
  },
]

// ---------------------------------------------------------------------------
// Data: Security pipeline stages
// ---------------------------------------------------------------------------

const PIPELINE_STAGES = [
  {
    title: 'User Request',
    icon: Globe,
    description: 'Browser sends request',
    detail: 'Next.js receives the HTTP request with auth cookies',
  },
  {
    title: 'Middleware',
    icon: Shield,
    description: 'Auth check',
    detail: 'Verifies JWT token exists; redirects to /login if not authenticated',
  },
  {
    title: 'Layout Guard',
    icon: Lock,
    description: 'Role verification',
    detail: 'Admin layout checks profile.role === "institution_admin"; shows Access Denied if not',
  },
  {
    title: 'Server Action',
    icon: KeyRound,
    description: 'Independent auth',
    detail: 'Re-verifies auth + ownership per mutation; uses admin client for DB operations',
  },
  {
    title: 'Supabase DB',
    icon: Database,
    description: 'PostgreSQL',
    detail: 'Admin client (service role) executes query; RLS bypassed after 3-layer verification',
  },
]

// ---------------------------------------------------------------------------
// Data: Database table groups with foreign-key connections
// ---------------------------------------------------------------------------

interface TableInfo {
  name: string
  connectsTo: string[]
}

interface TableGroup {
  id: string
  name: string
  icon: LucideIcon
  description: string
  tables: TableInfo[]
}

const TABLE_GROUPS: TableGroup[] = [
  {
    id: 'users',
    name: 'Users & Auth',
    icon: Users,
    description: 'Core user identity and profile management',
    tables: [
      { name: 'profiles', connectsTo: [] },
      { name: 'github_connections', connectsTo: ['profiles'] },
      { name: 'calendar_tokens', connectsTo: ['profiles'] },
    ],
  },
  {
    id: 'org',
    name: 'Organization',
    icon: Building2,
    description: 'Departments, programs, and faculty assignments',
    tables: [
      { name: 'departments', connectsTo: [] },
      { name: 'department_faculty', connectsTo: ['departments', 'profiles'] },
      { name: 'programs', connectsTo: ['departments', 'profiles'] },
    ],
  },
  {
    id: 'courses',
    name: 'Courses & Enrollment',
    icon: BookOpen,
    description: 'Course catalog, sections, and student enrollment',
    tables: [
      { name: 'courses', connectsTo: ['departments'] },
      { name: 'course_sections', connectsTo: ['courses', 'profiles'] },
      { name: 'enrollments', connectsTo: ['profiles', 'course_sections'] },
    ],
  },
  {
    id: 'content',
    name: 'Course Content',
    icon: Layers,
    description: 'Modules, items, and learning materials',
    tables: [
      { name: 'modules', connectsTo: ['course_sections'] },
      { name: 'module_items', connectsTo: ['modules'] },
    ],
  },
  {
    id: 'announcements',
    name: 'Announcements',
    icon: MessageSquare,
    description: 'Course announcements with reactions, comments, and mentions',
    tables: [
      { name: 'announcements', connectsTo: ['profiles', 'course_sections'] },
      { name: 'announcement_comments', connectsTo: ['announcements', 'profiles'] },
      { name: 'announcement_reactions', connectsTo: ['announcements', 'profiles'] },
      { name: 'announcement_reads', connectsTo: ['announcements', 'profiles'] },
      { name: 'announcement_mentions', connectsTo: ['announcements', 'profiles'] },
    ],
  },
  {
    id: 'quizzes',
    name: 'Quizzes & Assessment',
    icon: ClipboardCheck,
    description: 'Quiz creation, attempts, grading, and proctoring',
    tables: [
      { name: 'quiz_questions', connectsTo: ['course_sections'] },
      { name: 'quizzes', connectsTo: ['profiles', 'course_sections'] },
      { name: 'quiz_question_assignments', connectsTo: ['quizzes', 'quiz_questions'] },
      { name: 'quiz_attempts', connectsTo: ['quizzes', 'course_sections', 'profiles'] },
      { name: 'quiz_answers', connectsTo: ['quiz_attempts', 'quiz_questions'] },
      { name: 'quiz_proctoring_logs', connectsTo: ['quiz_attempts', 'quizzes', 'course_sections', 'profiles'] },
      { name: 'proctoring_snapshots', connectsTo: ['quiz_attempts', 'quizzes', 'course_sections', 'profiles'] },
    ],
  },
  {
    id: 'classroom',
    name: 'Live Classroom',
    icon: Radio,
    description: 'Live sessions with polls, quizzes, and Q&A',
    tables: [
      { name: 'lc_rooms', connectsTo: ['profiles', 'course_sections'] },
      { name: 'lc_interactions', connectsTo: ['lc_rooms', 'profiles'] },
      { name: 'lc_responses', connectsTo: ['lc_interactions', 'profiles'] },
      { name: 'lc_decks', connectsTo: ['lc_rooms', 'module_items'] },
      { name: 'lc_attendance', connectsTo: ['lc_rooms', 'profiles'] },
      { name: 'lc_session_reports', connectsTo: ['lc_rooms'] },
    ],
  },
  {
    id: 'projects',
    name: 'Projects',
    icon: FolderKanban,
    description: 'Team projects, phases, videos, showcase, and chat',
    tables: [
      { name: 'projects', connectsTo: ['course_sections', 'profiles'] },
      { name: 'project_teams', connectsTo: ['projects', 'profiles'] },
      { name: 'project_members', connectsTo: ['projects', 'profiles', 'project_teams'] },
      { name: 'project_phases', connectsTo: ['projects', 'project_teams'] },
      { name: 'phase_items', connectsTo: ['project_phases', 'profiles'] },
      { name: 'project_repositories', connectsTo: ['projects'] },
      { name: 'project_commits', connectsTo: ['projects', 'project_repositories', 'profiles'] },
      { name: 'project_grades', connectsTo: ['projects', 'project_teams', 'profiles'] },
      { name: 'project_chat_channels', connectsTo: ['project_teams', 'profiles'] },
      { name: 'project_chat_messages', connectsTo: ['project_chat_channels', 'profiles'] },
      { name: 'project_videos', connectsTo: ['projects', 'project_teams', 'profiles'] },
      { name: 'project_showcase', connectsTo: ['projects', 'project_teams', 'profiles'] },
      { name: 'future_contributors', connectsTo: ['projects', 'profiles'] },
    ],
  },
  {
    id: 'officehours',
    name: 'Office Hours',
    icon: Calendar,
    description: 'Professor scheduling and student booking',
    tables: [
      { name: 'office_hours', connectsTo: ['courses', 'profiles'] },
      { name: 'bookings', connectsTo: ['office_hours', 'profiles', 'courses'] },
      { name: 'blocked_times', connectsTo: ['profiles'] },
    ],
  },
  {
    id: 'roadmap',
    name: 'Roadmap',
    icon: Map,
    description: 'Visual learning roadmap with progress tracking',
    tables: [
      { name: 'roadmap_progress', connectsTo: ['course_sections', 'profiles'] },
      { name: 'roadmap_edges', connectsTo: ['course_sections'] },
    ],
  },
  {
    id: 'badges',
    name: 'Badges & Challenges',
    icon: Award,
    description: 'Gamification with challenges and badge awards',
    tables: [
      { name: 'badges', connectsTo: ['profiles', 'course_sections'] },
      { name: 'challenges', connectsTo: ['profiles', 'course_sections', 'badges'] },
      { name: 'challenge_claims', connectsTo: ['profiles', 'challenges'] },
      { name: 'challenge_submissions', connectsTo: ['challenge_claims'] },
      { name: 'user_badges', connectsTo: ['profiles', 'badges', 'course_sections'] },
    ],
  },
  {
    id: 'intel',
    name: 'Course Intel',
    icon: GraduationCap,
    description: 'Student-driven course reviews, Q&A, tips, and resources',
    tables: [
      { name: 'course_questions', connectsTo: ['profiles', 'courses'] },
      { name: 'course_answers', connectsTo: ['profiles', 'course_questions'] },
      { name: 'course_answer_votes', connectsTo: ['profiles', 'course_answers'] },
      { name: 'course_tips', connectsTo: ['profiles', 'courses'] },
      { name: 'course_tip_votes', connectsTo: ['profiles', 'course_tips'] },
      { name: 'course_reviews', connectsTo: ['profiles', 'courses'] },
      { name: 'course_professor_insights', connectsTo: ['profiles', 'courses'] },
      { name: 'course_resources', connectsTo: ['profiles', 'courses'] },
    ],
  },
  {
    id: 'events',
    name: 'System Events',
    icon: Activity,
    description: 'Audit trail for all user actions',
    tables: [
      { name: 'events', connectsTo: ['profiles', 'course_sections'] },
    ],
  },
]

// ---------------------------------------------------------------------------
// Data: Storage buckets
// ---------------------------------------------------------------------------

const STORAGE_BUCKETS = [
  { name: 'course-materials', description: 'Module files, warehouse content, formula sheets', icon: FileText },
  { name: 'project-videos', description: 'Project submission videos', icon: FolderKanban },
  { name: 'course-resources', description: 'Syllabi, reading lists, references', icon: BookOpen },
  { name: 'challenge-submissions', description: 'Student challenge submission files', icon: Award },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const totalTables = TABLE_GROUPS.reduce((sum, g) => sum + g.tables.length, 0)
const totalRelationships = TABLE_GROUPS.reduce(
  (sum, g) => sum + g.tables.reduce((s, t) => s + t.connectsTo.length, 0),
  0,
)

/** Build a reverse lookup: for each table, which tables reference it */
function buildReverseMap() {
  const map: Record<string, string[]> = {}
  for (const group of TABLE_GROUPS) {
    for (const table of group.tables) {
      for (const target of table.connectsTo) {
        if (!map[target]) map[target] = []
        map[target].push(table.name)
      }
    }
  }
  return map
}

/** Find which group a table belongs to */
function findGroup(tableName: string): TableGroup | undefined {
  return TABLE_GROUPS.find(g => g.tables.some(t => t.name === tableName))
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SupabaseArchitectureVisual() {
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const reverseMap = useMemo(() => buildReverseMap(), [])

  // Dismiss selected table on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedTable(null)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Compute highlighted tables when one is selected
  const highlighted = useMemo(() => {
    if (!selectedTable) return new Set<string>()
    const set = new Set<string>()
    set.add(selectedTable)
    // Forward connections (this table references…)
    const tableInfo = TABLE_GROUPS.flatMap(g => g.tables).find(t => t.name === selectedTable)
    if (tableInfo) tableInfo.connectsTo.forEach(t => set.add(t))
    // Reverse connections (…these tables reference this one)
    if (reverseMap[selectedTable]) reverseMap[selectedTable].forEach(t => set.add(t))
    return set
  }, [selectedTable, reverseMap])

  const selectedTableInfo = selectedTable
    ? TABLE_GROUPS.flatMap(g => g.tables).find(t => t.name === selectedTable)
    : null

  return (
    <div className="space-y-20 pb-20">
      {/* ----------------------------------------------------------------- */}
      {/* HEADER */}
      {/* ----------------------------------------------------------------- */}
      <motion.section initial="hidden" animate="visible" variants={stagger}>
        <motion.div variants={fadeUp}>
          <p className="text-[11px] tracking-[0.2em] uppercase text-muted-foreground font-semibold mb-4">
            System Architecture
          </p>
          <h1 className="font-[family-name:var(--font-instrument-serif)] text-[clamp(32px,5vw,56px)] leading-[1.1] mb-3">
            Supabase <em className="italic text-muted-foreground">Connection Map</em>
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl">
            How Scholera connects to Supabase — clients, security layers, {totalTables} tables across {TABLE_GROUPS.length} domains, and {totalRelationships} foreign-key relationships.
          </p>
        </motion.div>

        {/* Stats row */}
        <motion.div variants={fadeUp} className="mt-8 flex flex-wrap gap-6">
          {[
            { label: 'Tables', value: totalTables },
            { label: 'Domains', value: TABLE_GROUPS.length },
            { label: 'Relationships', value: totalRelationships },
            { label: 'Clients', value: 3 },
            { label: 'Buckets', value: STORAGE_BUCKETS.length },
          ].map(stat => (
            <div key={stat.label} className="bg-card border border-border rounded-2xl px-6 py-4">
              <p className="font-[family-name:var(--font-instrument-serif)] text-3xl">{stat.value}</p>
              <p className="text-[11px] tracking-[0.15em] uppercase text-muted-foreground font-semibold mt-1">
                {stat.label}
              </p>
            </div>
          ))}
        </motion.div>
      </motion.section>

      {/* ----------------------------------------------------------------- */}
      {/* CLIENT ARCHITECTURE */}
      {/* ----------------------------------------------------------------- */}
      <motion.section initial="hidden" whileInView="visible" viewport={{ once: true }} variants={stagger}>
        <motion.div variants={fadeUp} className="mb-10">
          <p className="text-[11px] tracking-[0.2em] uppercase text-muted-foreground font-semibold mb-4">
            Client Architecture
          </p>
          <h2 className="font-[family-name:var(--font-instrument-serif)] text-3xl">
            Three clients, <em className="italic text-muted-foreground">one database</em>
          </h2>
        </motion.div>

        {/* Supabase Cloud node */}
        <motion.div variants={fadeUp} className="flex justify-center">
          <div className="bg-card border-[1.5px] border-foreground rounded-3xl px-10 py-6 text-center max-w-md">
            <div className="w-14 h-14 border border-border rounded-xl flex items-center justify-center bg-muted/50 mx-auto mb-3">
              <Database className="w-7 h-7" />
            </div>
            <h3 className="font-[family-name:var(--font-instrument-serif)] text-2xl mb-1">Supabase Cloud</h3>
            <p className="text-muted-foreground text-sm">PostgreSQL + Auth + Storage + Realtime</p>
          </div>
        </motion.div>

        {/* Connector lines: vertical → horizontal → 3 verticals */}
        <div className="flex justify-center">
          <div className="w-px h-10 bg-border" />
        </div>
        <div className="hidden md:block mx-auto w-2/3 max-w-3xl h-px bg-border" />
        <div className="hidden md:grid grid-cols-3 w-2/3 max-w-3xl mx-auto">
          <div className="flex justify-center"><div className="w-px h-8 bg-border" /></div>
          <div className="flex justify-center"><div className="w-px h-8 bg-border" /></div>
          <div className="flex justify-center"><div className="w-px h-8 bg-border" /></div>
        </div>

        {/* Three client cards */}
        <motion.div variants={stagger} className="grid md:grid-cols-3 gap-6 mt-2 md:mt-0">
          {CLIENTS.map(client => (
            <motion.div
              key={client.id}
              variants={fadeUp}
              className="bg-card border border-border rounded-2xl p-6 hover:-translate-y-1 transition-transform duration-500"
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 border border-border rounded-xl flex items-center justify-center bg-muted/50">
                  <client.icon className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-semibold">{client.name}</h4>
                  <code className="text-[12px] text-muted-foreground">{client.file}</code>
                </div>
              </div>

              <p className="text-sm text-muted-foreground mb-4">{client.description}</p>

              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <KeyRound className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-[12px] font-medium">{client.key}</span>
                </div>
                <div className="flex items-center gap-2">
                  {client.rls ? (
                    <Lock className="w-3.5 h-3.5 text-muted-foreground" />
                  ) : (
                    <Shield className="w-3.5 h-3.5 text-muted-foreground" />
                  )}
                  <span className="text-[12px]">
                    RLS {client.rls ? 'Enforced' : 'Bypassed'}
                  </span>
                </div>
              </div>

              <div className="mt-4 pt-4 border-t border-border">
                <p className="text-[11px] tracking-[0.15em] uppercase text-muted-foreground font-semibold mb-2">
                  Used By
                </p>
                <ul className="space-y-1">
                  {client.usedBy.map(use => (
                    <li key={use} className="text-[12px] text-muted-foreground flex items-center gap-1.5">
                      <span className="w-1 h-1 rounded-full bg-muted-foreground/40" />
                      {use}
                    </li>
                  ))}
                </ul>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </motion.section>

      {/* ----------------------------------------------------------------- */}
      {/* SECURITY PIPELINE */}
      {/* ----------------------------------------------------------------- */}
      <motion.section initial="hidden" whileInView="visible" viewport={{ once: true }} variants={stagger}>
        <motion.div variants={fadeUp} className="mb-10">
          <p className="text-[11px] tracking-[0.2em] uppercase text-muted-foreground font-semibold mb-4">
            Security Pipeline
          </p>
          <h2 className="font-[family-name:var(--font-instrument-serif)] text-3xl">
            Every request, <em className="italic text-muted-foreground">three layers deep</em>
          </h2>
        </motion.div>

        {/* Horizontal flow — stacks on mobile */}
        <motion.div variants={stagger} className="flex flex-col lg:flex-row items-stretch gap-3">
          {PIPELINE_STAGES.map((stage, i) => (
            <motion.div key={stage.title} variants={fadeUp} className="flex flex-col lg:flex-row items-center gap-3 flex-1">
              <div className="bg-card border border-border rounded-2xl p-5 flex-1 w-full">
                <div className="w-10 h-10 border border-border rounded-xl flex items-center justify-center bg-muted/50 mb-3">
                  <stage.icon className="w-5 h-5" />
                </div>
                <h4 className="font-semibold text-sm mb-1">{stage.title}</h4>
                <p className="text-[12px] text-muted-foreground font-medium mb-2">{stage.description}</p>
                <p className="text-[11px] text-muted-foreground/70 leading-relaxed">{stage.detail}</p>
              </div>
              {i < PIPELINE_STAGES.length - 1 && (
                <div className="flex-shrink-0">
                  <ArrowRight className="w-4 h-4 text-muted-foreground hidden lg:block" />
                  <ArrowDown className="w-4 h-4 text-muted-foreground lg:hidden" />
                </div>
              )}
            </motion.div>
          ))}
        </motion.div>
      </motion.section>

      {/* ----------------------------------------------------------------- */}
      {/* DATABASE SCHEMA MAP */}
      {/* ----------------------------------------------------------------- */}
      <motion.section initial="hidden" whileInView="visible" viewport={{ once: true }} variants={stagger}>
        <motion.div variants={fadeUp} className="mb-10">
          <p className="text-[11px] tracking-[0.2em] uppercase text-muted-foreground font-semibold mb-4">
            Database Schema
          </p>
          <h2 className="font-[family-name:var(--font-instrument-serif)] text-3xl mb-2">
            {totalTables} tables, <em className="italic text-muted-foreground">{TABLE_GROUPS.length} domains</em>
          </h2>
          <p className="text-sm text-muted-foreground">
            Click any table to see its foreign-key connections highlighted across all domains.
          </p>
        </motion.div>

        <motion.div variants={stagger} className="grid md:grid-cols-2 xl:grid-cols-3 gap-5">
          {TABLE_GROUPS.map(group => {
            const hasHighlightedTable = selectedTable && group.tables.some(t => highlighted.has(t.name))
            return (
              <motion.div
                key={group.id}
                variants={fadeUp}
                className={`bg-card border rounded-2xl p-5 transition-[border-color,box-shadow] duration-300 ${
                  hasHighlightedTable
                    ? 'border-foreground/40 shadow-lg'
                    : 'border-border'
                }`}
              >
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 border border-border rounded-xl flex items-center justify-center bg-muted/50">
                    <group.icon className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="font-semibold text-sm">{group.name}</h4>
                    <p className="text-[11px] text-muted-foreground">{group.tables.length} tables</p>
                  </div>
                </div>

                <p className="text-[12px] text-muted-foreground mb-4">{group.description}</p>

                <div className="flex flex-wrap gap-1.5">
                  {group.tables.map(table => {
                    const isSelected = selectedTable === table.name
                    const isHighlighted = selectedTable && highlighted.has(table.name) && !isSelected
                    return (
                      <button
                        key={table.name}
                        onClick={() => setSelectedTable(isSelected ? null : table.name)}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-mono transition-[color,background-color,box-shadow,transform] duration-200 cursor-pointer ${
                          isSelected
                            ? 'bg-primary text-primary-foreground font-semibold scale-105'
                            : isHighlighted
                            ? 'bg-foreground/15 text-foreground font-medium ring-1 ring-foreground/30'
                            : selectedTable
                            ? 'bg-muted/30 text-muted-foreground/50'
                            : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                        }`}
                      >
                        {table.name}
                      </button>
                    )
                  })}
                </div>
              </motion.div>
            )
          })}
        </motion.div>

        {/* Selected table detail panel */}
        {selectedTable && selectedTableInfo && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-6 bg-card border-[1.5px] border-foreground rounded-2xl p-6"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-foreground text-background rounded-xl flex items-center justify-center">
                  <Eye className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-mono font-semibold">{selectedTable}</h4>
                  <p className="text-[11px] text-muted-foreground">
                    {findGroup(selectedTable)?.name} domain
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedTable(null)}
                className="text-[12px] text-muted-foreground hover:text-foreground transition-colors px-3 py-1 rounded-full border border-border"
              >
                Clear
              </button>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              {/* Forward references */}
              <div>
                <p className="text-[11px] tracking-[0.15em] uppercase text-muted-foreground font-semibold mb-3 flex items-center gap-2">
                  <ArrowRight className="w-3 h-3" />
                  References ({selectedTableInfo.connectsTo.length})
                </p>
                {selectedTableInfo.connectsTo.length > 0 ? (
                  <div className="space-y-1.5">
                    {selectedTableInfo.connectsTo.map(target => (
                      <button
                        key={target}
                        onClick={() => setSelectedTable(target)}
                        className="flex items-center gap-2 text-[12px] font-mono text-foreground hover:text-foreground/70 transition-colors cursor-pointer"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-foreground" />
                        {target}
                        <span className="text-muted-foreground/50">({findGroup(target)?.name})</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12px] text-muted-foreground/50 italic">No outgoing references (root table)</p>
                )}
              </div>

              {/* Reverse references */}
              <div>
                <p className="text-[11px] tracking-[0.15em] uppercase text-muted-foreground font-semibold mb-3 flex items-center gap-2">
                  <Zap className="w-3 h-3" />
                  Referenced By ({reverseMap[selectedTable]?.length || 0})
                </p>
                {reverseMap[selectedTable]?.length > 0 ? (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {reverseMap[selectedTable].map(source => (
                      <button
                        key={source}
                        onClick={() => setSelectedTable(source)}
                        className="flex items-center gap-2 text-[12px] font-mono text-foreground hover:text-foreground/70 transition-colors cursor-pointer"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground" />
                        {source}
                        <span className="text-muted-foreground/50">({findGroup(source)?.name})</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12px] text-muted-foreground/50 italic">No tables reference this one</p>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </motion.section>

      {/* ----------------------------------------------------------------- */}
      {/* STORAGE & REALTIME */}
      {/* ----------------------------------------------------------------- */}
      <motion.section initial="hidden" whileInView="visible" viewport={{ once: true }} variants={stagger}>
        <motion.div variants={fadeUp} className="mb-10">
          <p className="text-[11px] tracking-[0.2em] uppercase text-muted-foreground font-semibold mb-4">
            Infrastructure
          </p>
          <h2 className="font-[family-name:var(--font-instrument-serif)] text-3xl">
            Storage <em className="italic text-muted-foreground">& Realtime</em>
          </h2>
        </motion.div>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Storage Buckets */}
          <motion.div variants={fadeUp} className="bg-card border border-border rounded-2xl p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 border border-border rounded-xl flex items-center justify-center bg-muted/50">
                <HardDrive className="w-5 h-5" />
              </div>
              <div>
                <h4 className="font-semibold">Storage Buckets</h4>
                <p className="text-[11px] text-muted-foreground">Supabase Storage (S3-compatible)</p>
              </div>
            </div>
            <div className="space-y-3">
              {STORAGE_BUCKETS.map(bucket => (
                <div
                  key={bucket.name}
                  className="flex items-start gap-3 p-3 bg-muted/20 rounded-xl"
                >
                  <div className="w-8 h-8 border border-border rounded-lg flex items-center justify-center bg-background mt-0.5">
                    <bucket.icon className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-[12px] font-mono font-medium">{bucket.name}</p>
                    <p className="text-[11px] text-muted-foreground">{bucket.description}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 pt-4 border-t border-border text-[11px] text-muted-foreground">
              Max file size: 50 MB &middot; Sanitized filenames &middot; Timestamp-based naming
            </div>
          </motion.div>

          {/* Realtime */}
          <motion.div variants={fadeUp} className="bg-card border border-border rounded-2xl p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 border border-border rounded-xl flex items-center justify-center bg-muted/50">
                <Zap className="w-5 h-5" />
              </div>
              <div>
                <h4 className="font-semibold">Realtime Subscriptions</h4>
                <p className="text-[11px] text-muted-foreground">postgres_changes via WebSocket</p>
              </div>
            </div>

            <div className="space-y-3 mb-5">
              <div className="p-3 bg-muted/20 rounded-xl">
                <p className="text-[12px] font-mono font-medium mb-1">useRealtimeSubscription</p>
                <p className="text-[11px] text-muted-foreground">
                  Generic React hook for subscribing to INSERT, UPDATE, DELETE events on any table with optional row-level filtering.
                </p>
              </div>
              <div className="p-3 bg-muted/20 rounded-xl">
                <p className="text-[12px] font-medium mb-1">Active in Classroom Mode</p>
                <p className="text-[11px] text-muted-foreground">
                  Live polls, quiz responses, session participants, and Q&A all use real-time subscriptions for instant updates.
                </p>
              </div>
            </div>

            <div className="pt-4 border-t border-border">
              <p className="text-[11px] tracking-[0.15em] uppercase text-muted-foreground font-semibold mb-3">
                Realtime-Enabled Tables
              </p>
              <div className="flex flex-wrap gap-1.5">
                {[
                  'lc_rooms', 'lc_interactions', 'lc_responses',
                  'lc_events', 'lc_slide_annotations',
                ].map(table => (
                  <button
                    key={table}
                    onClick={() => setSelectedTable(table)}
                    className="px-2 py-0.5 rounded-md text-[10px] font-mono bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
                  >
                    {table}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        </div>
      </motion.section>

      {/* ----------------------------------------------------------------- */}
      {/* QUERY LAYER */}
      {/* ----------------------------------------------------------------- */}
      <motion.section initial="hidden" whileInView="visible" viewport={{ once: true }} variants={stagger}>
        <motion.div variants={fadeUp} className="mb-10">
          <p className="text-[11px] tracking-[0.2em] uppercase text-muted-foreground font-semibold mb-4">
            Query Layer
          </p>
          <h2 className="font-[family-name:var(--font-instrument-serif)] text-3xl">
            Centralized queries, <em className="italic text-muted-foreground">one source of truth</em>
          </h2>
        </motion.div>

        <motion.div variants={fadeUp} className="bg-card border border-border rounded-2xl p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 border border-border rounded-xl flex items-center justify-center bg-muted/50">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <h4 className="font-semibold">queries.ts</h4>
              <p className="text-[11px] text-muted-foreground">16 query modules &middot; ~3,000 lines &middot; dependency-injected client</p>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {[
              'dashboardQueries', 'profileQueries', 'courseQueries', 'enrollmentQueries',
              'departmentQueries', 'courseAdminQueries', 'professorQueries', 'courseAssignmentQueries',
              'studentQueries', 'adminDashboardQueries', 'programQueries', 'enrollmentAdminQueries',
              'studentCatalogQueries', 'roadmapQueries', 'projectQueries',
            ].map(module => (
              <div
                key={module}
                className="px-3 py-2 bg-muted/30 rounded-lg text-[11px] font-mono text-muted-foreground"
              >
                {module}
              </div>
            ))}
          </div>

          <div className="mt-5 pt-4 border-t border-border grid sm:grid-cols-3 gap-4 text-[12px] text-muted-foreground">
            <div>
              <p className="font-medium text-foreground mb-1">Error Handling</p>
              <p>Every function catches errors, logs via logger.error(), returns safe fallbacks</p>
            </div>
            <div>
              <p className="font-medium text-foreground mb-1">Dependency Injection</p>
              <p>Client passed as first parameter — works with both server and browser instances</p>
            </div>
            <div>
              <p className="font-medium text-foreground mb-1">Audit Trail</p>
              <p>Mutations call logEvent() for fire-and-forget event logging to events table</p>
            </div>
          </div>
        </motion.div>
      </motion.section>
    </div>
  )
}
