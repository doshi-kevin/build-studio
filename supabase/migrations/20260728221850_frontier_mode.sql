-- Frontier Mode — the private design record behind a designed assignment.
--
-- Why a table and not a JSONB blob on `assignments`: this is the row a future freshness
-- pass reads to answer "which of my assignments have gone stale, and what do I re-check?"
-- across a whole section, so it has to be queryable and indexable rather than buried in a
-- settings document. `quizzes` also has no settings column at all, so the JSONB route
-- would have needed a migration anyway — it saves nothing.
--
-- Why it exists at all: the individuation axis and the reference invariants are exactly
-- what make a Frontier assignment hard to copy, so they must NEVER live in a
-- student-facing field. One professor forgetting to strip an "instructor only" block out
-- of assignment instructions before publishing would hand students the answer key and the
-- reason copying fails. A separate table makes that leak structurally impossible.
--
-- Subject: exactly ONE of assignment_id / quiz_id, enforced by a CHECK. Two nullable FKs
-- rather than a polymorphic (subject_type, subject_id) pair so cascade-delete and
-- referential integrity actually work, and so the RLS check stays cheap. The quiz side is
-- not written yet (Frontier is coerced to standard on the quiz kind) — the column exists
-- now so enabling it later needs no second migration.
--
-- Tenancy: institution_id + section_id + created_by are DENORMALIZED so RLS authorizes
-- LOCALLY with no cross-table JOIN (the "RLS planner cliff" the athena_conversations
-- migration documents). All three are written from VERIFIED server context, never client
-- input. Readable by section staff — the auto-vs-judgment tagging and the grading workflow
-- are precisely what a TA grading the thing needs — and writable only via the service role.

-- ── Table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.assignment_designs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- exactly one subject (CHECK below)
  assignment_id uuid REFERENCES public.assignments(id) ON DELETE CASCADE,
  quiz_id uuid REFERENCES public.quizzes(id) ON DELETE CASCADE,

  -- denormalized for JOIN-free RLS + analytics; always from verified server context
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- the design itself
  spine text NOT NULL,                    -- the durable concept, one sentence
  shell text NOT NULL,                    -- the current real-world vehicle, one sentence
  shell_check text,                       -- what the grounded search established, + source
  individuation_axis text NOT NULL,       -- why a copied submission is visibly WRONG
  verification_mode text NOT NULL
    CHECK (verification_mode IN ('reconciliation', 'provenance', 'raw_vs_processed', 'delta', 'physical_evidence')),
  failure_modes jsonb NOT NULL DEFAULT '[]'::jsonb,        -- [{failure, acceptanceClause}]
  rot_notes text NOT NULL,                -- what goes stale, when, what to re-verify
  reference_invariants jsonb NOT NULL DEFAULT '[]'::jsonb, -- answer-key invariants (staff-only)
  criterion_tags jsonb NOT NULL DEFAULT '[]'::jsonb,       -- [{question, criterion, tag}]
  gate_report jsonb NOT NULL DEFAULT '[]'::jsonb,          -- Athena's OWN justifications
  waivers jsonb NOT NULL DEFAULT '[]'::jsonb,              -- properties deliberately skipped

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT assignment_designs_one_subject CHECK (
    (assignment_id IS NOT NULL AND quiz_id IS NULL)
    OR (assignment_id IS NULL AND quiz_id IS NOT NULL)
  )
);

COMMENT ON TABLE public.assignment_designs IS
  'Private (staff-only) design record behind a Frontier-designed assignment or quiz: spine/shell, individuation axis, failure modes, rot notes and answer-key invariants. Never student-facing. Writes via service role only.';

-- ── Indexes ────────────────────────────────────────────────────
-- One design per subject; the arc UPSERTS so re-running it revises in place.
--
-- NOT partial, deliberately. A `WHERE <col> IS NOT NULL` predicate here looks tidy but
-- breaks the upsert: Postgres will not infer a PARTIAL index from `ON CONFLICT (col)`
-- unless the statement repeats the predicate, which PostgREST cannot emit — so every
-- upsert died with "no unique or exclusion constraint matching the ON CONFLICT
-- specification". The predicate was never needed anyway: Postgres already treats NULLs as
-- distinct in a unique index, so the many rows with a NULL assignment_id (quiz designs)
-- coexist fine while the non-null ones stay unique. Verified by runtime QA.
CREATE UNIQUE INDEX IF NOT EXISTS uq_assignment_designs_assignment
  ON public.assignment_designs (assignment_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_assignment_designs_quiz
  ON public.assignment_designs (quiz_id);

-- The freshness-pass / staff-listing query, and the RLS filter column.
-- (FK columns are not auto-indexed by Postgres.)
CREATE INDEX IF NOT EXISTS idx_assignment_designs_section
  ON public.assignment_designs (section_id, created_at DESC);

-- ── RLS ────────────────────────────────────────────────────────
ALTER TABLE public.assignment_designs ENABLE ROW LEVEL SECURITY;

-- Section staff (professor/owner or active staff, incl. TAs) may READ. Section membership
-- already implies institution membership, so scoping on section_id is the whole tenant
-- check — and it stays a single cheap helper call per row instead of a profiles JOIN.
-- DROP-then-CREATE because Postgres has no `CREATE POLICY IF NOT EXISTS`. Every other
-- object here is guarded, so without this the migration is the one statement that makes a
-- re-run fail — which matters: prod stamps its own migration version via the MCP, so this
-- file gets re-applied by `supabase migration up` on any machine that already has the
-- table, and an interrupted prod apply could not simply be retried. Same shape as the
-- DROP TRIGGER IF EXISTS below.
DROP POLICY IF EXISTS "Section staff read assignment designs" ON public.assignment_designs;
CREATE POLICY "Section staff read assignment designs"
  ON public.assignment_designs FOR SELECT
  TO authenticated
  USING (public.is_section_owner_or_staff(section_id));

-- No INSERT/UPDATE/DELETE policies: all writes happen via the service role, behind a
-- server action that re-verifies staff access and re-checks the subject belongs to the
-- verified section. A FOR ALL policy here would be a client write hole.

-- ── updated_at ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_assignment_designs_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assignment_designs_updated_at ON public.assignment_designs;
CREATE TRIGGER trg_assignment_designs_updated_at
  BEFORE UPDATE ON public.assignment_designs
  FOR EACH ROW EXECUTE FUNCTION public.set_assignment_designs_updated_at();

-- ── Atomic merge into assignments.settings ─────────────────────
-- assignments.settings is a SHARED JSONB column: the notebook studio autosaves
-- `settings.studio` on a debounce while the professor types, and the rubric lives at
-- `settings.rubric`. Every existing writer does read-modify-write in application code —
-- read the whole column, splice one key, write the whole column back — which loses an
-- update whenever two writers interleave. Frontier makes that collision likely rather than
-- theoretical: Athena writes a rubric *while* the professor may be typing on the canvas, so
-- one autosave landing mid-write silently discards either the rubric or their last edits.
--
-- This does the splice inside Postgres instead, so a concurrent writer touching a DIFFERENT
-- key cannot be clobbered. p_value NULL removes the key (the Undo direction).
--
-- Service-role only: Supabase auto-grants EXECUTE to anon/authenticated, so the revoke is
-- required — the caller must have already verified section staff + subject ownership.
CREATE OR REPLACE FUNCTION public.assignment_settings_merge(
  p_assignment_id uuid,
  p_key text,
  p_value jsonb DEFAULT NULL
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.assignments
     SET settings = CASE
           WHEN p_value IS NULL THEN coalesce(settings, '{}'::jsonb) - p_key
           ELSE jsonb_set(coalesce(settings, '{}'::jsonb), array[p_key], p_value, true)
         END,
         updated_at = now()
   WHERE id = p_assignment_id;
$$;

REVOKE ALL ON FUNCTION public.assignment_settings_merge(uuid, text, jsonb) FROM public;
REVOKE ALL ON FUNCTION public.assignment_settings_merge(uuid, text, jsonb) FROM anon, authenticated;
