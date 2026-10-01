-- Shared event layer — feed_items
--
-- One per-recipient table that BOTH surfaces read: Preet's notifications (bell/toast)
-- and Elizabeth's dashboard to-do list. "Emit once, consume twice" — an event is
-- fanned out to one feed_items row per recipient; each surface filters/renders its own
-- way. See docs/designs/notifications-calendar/shared-event-layer.md (PR #319).
--
-- Announcements are first-class here (type 'announcement_posted', entity_type
-- 'announcement') so the dashboard can show them and a future announcement-notification
-- reuses the same layer.
--
-- Writes happen ONLY via the admin client in server actions / the emit helper, so the
-- client policy is SELECT-only (read) — mark-read/done/dismiss go through server actions.

-- ══════════════════════════════════════════════════════════════════
-- 1. Table
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.feed_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  actor_id       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  section_id     uuid REFERENCES public.course_sections(id) ON DELETE CASCADE,
  type           text NOT NULL,                       -- EventType (shared vocabulary)
  title          text NOT NULL CHECK (char_length(title) <= 300),
  body           text CHECK (body IS NULL OR char_length(body) <= 1000),
  link_url       text CHECK (link_url IS NULL OR char_length(link_url) <= 500),
  entity_type    text,                                -- 'assignment' | 'quiz' | 'announcement' | ...
  entity_id      uuid,
  is_read        boolean NOT NULL DEFAULT false,      -- notification lifecycle
  read_at        timestamptz,
  is_actionable  boolean NOT NULL DEFAULT false,      -- true => a to-do (needs completion)
  is_done        boolean NOT NULL DEFAULT false,      -- to-do lifecycle
  done_at        timestamptz,
  due_at         timestamptz,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.feed_items IS 'Shared per-recipient event feed. Read by both the notification bell and the dashboard to-do list. One row per (recipient, event).';
COMMENT ON COLUMN public.feed_items.type IS 'EventType discriminator (assignment_published, grade_released, announcement_posted, deadline_approaching, ...). No CHECK so new types are additive; the canonical list lives in src/lib/events/types.ts.';
COMMENT ON COLUMN public.feed_items.is_actionable IS 'true = a to-do the recipient must complete (submit/attempt); false = an informational notice.';

-- ── Indexes ────────────────────────────────────────────────────────
-- Feed list (both surfaces): newest first per recipient.
CREATE INDEX IF NOT EXISTS idx_feed_items_recipient_created
  ON public.feed_items(recipient_id, created_at DESC);
-- Unread badge (notifications hot path).
CREATE INDEX IF NOT EXISTS idx_feed_items_recipient_unread
  ON public.feed_items(recipient_id) WHERE is_read = false;
-- Open to-dos (dashboard hot path).
CREATE INDEX IF NOT EXISTS idx_feed_items_recipient_todo
  ON public.feed_items(recipient_id) WHERE is_actionable = true AND is_done = false;
-- Completion events flip is_done by entity.
CREATE INDEX IF NOT EXISTS idx_feed_items_entity
  ON public.feed_items(entity_type, entity_id);
-- Dedup / upsert key: at most one row per (recipient, type, entity). Lets emit and
-- backfill be idempotent via ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS uq_feed_items_recipient_type_entity
  ON public.feed_items(recipient_id, type, entity_id) WHERE entity_id IS NOT NULL;

-- ── RLS: recipients read their own; all writes via admin client ────
ALTER TABLE public.feed_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Recipients read own feed items"
  ON public.feed_items FOR SELECT
  USING (recipient_id = (select auth.uid()));

-- No INSERT/UPDATE/DELETE policy for authenticated/anon: the emit helper and the
-- read/mark server actions use the service-role admin client (bypasses RLS). Keeping
-- the client read-only prevents a recipient from writing arbitrary columns via
-- direct PostgREST (e.g. flipping is_done on someone's to-do). See
-- .claude/rules/security-migrations.md.

-- ── Realtime: bell + dashboard subscribe to their own rows ─────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.feed_items;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════
-- 2. Backfill — so both dashboards aren't empty at cutover
-- ══════════════════════════════════════════════════════════════════
-- For each currently-published assignment / quiz / announcement, insert one
-- feed_items row per enrolled student. Idempotent (ON CONFLICT DO NOTHING on the
-- dedup index). Actionable items (assignment/quiz) are marked done where the student
-- already submitted/attempted. Enrollment audience = enrolled/active/completed.

-- Assignments (actionable to-dos)
INSERT INTO public.feed_items
  (recipient_id, actor_id, institution_id, section_id, type, title, link_url,
   entity_type, entity_id, is_actionable, is_done, done_at, due_at, created_at)
SELECT e.student_id, a.created_by, a.institution_id, a.section_id,
       'assignment_published', 'New assignment: ' || a.title,
       '/student/courses/' || a.section_id || '/assignments/' || a.id,
       'assignment', a.id, true,
       (s.id IS NOT NULL AND s.status IN ('submitted','graded')),
       CASE WHEN s.status IN ('submitted','graded') THEN s.submitted_at END,
       a.due_at, COALESCE(a.published_at, a.created_at)
FROM public.assignments a
JOIN public.enrollments e
  ON e.section_id = a.section_id AND e.status IN ('enrolled','active','completed')
LEFT JOIN public.assignment_submissions s
  ON s.assignment_id = a.id AND s.student_id = e.student_id
WHERE a.status = 'published'
ON CONFLICT (recipient_id, type, entity_id) WHERE entity_id IS NOT NULL DO NOTHING;

-- Quizzes (actionable to-dos)
INSERT INTO public.feed_items
  (recipient_id, actor_id, institution_id, section_id, type, title, link_url,
   entity_type, entity_id, is_actionable, is_done, done_at, due_at, created_at)
SELECT e.student_id, q.created_by, cs.institution_id, q.section_id,
       'quiz_published', 'New quiz: ' || q.title,
       '/student/courses/' || q.section_id || '/quizzes/' || q.id,
       'quiz', q.id, true,
       (att.id IS NOT NULL),
       att.submitted_at, q.due_date, COALESCE(q.created_at, now())
FROM public.quizzes q
JOIN public.course_sections cs ON cs.id = q.section_id
JOIN public.enrollments e
  ON e.section_id = q.section_id AND e.status IN ('enrolled','active','completed')
LEFT JOIN public.quiz_attempts att
  ON att.quiz_id = q.id AND att.student_id = e.student_id AND att.status = 'submitted'
WHERE q.status = 'published'
ON CONFLICT (recipient_id, type, entity_id) WHERE entity_id IS NOT NULL DO NOTHING;

-- Announcements (informational notices — not actionable)
INSERT INTO public.feed_items
  (recipient_id, actor_id, institution_id, section_id, type, title, link_url,
   entity_type, entity_id, is_actionable, created_at)
SELECT e.student_id, an.author_id, cs.institution_id, an.section_id,
       'announcement_posted', 'New announcement: ' || an.title,
       '/student/courses/' || an.section_id || '/announcements',
       'announcement', an.id, false,
       COALESCE(an.published_at, an.created_at)
FROM public.announcements an
JOIN public.course_sections cs ON cs.id = an.section_id
JOIN public.enrollments e
  ON e.section_id = an.section_id AND e.status IN ('enrolled','active','completed')
WHERE an.status = 'published'
ON CONFLICT (recipient_id, type, entity_id) WHERE entity_id IS NOT NULL DO NOTHING;
