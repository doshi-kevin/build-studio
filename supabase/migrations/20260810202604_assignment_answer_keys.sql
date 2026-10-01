-- Parsed answer-key text, prepared ONCE when the professor uploads the key
-- (feature/ai-grading).
--
-- The AI grader needs the answer key as plain text in the prompt. Today that
-- text is re-downloaded and re-parsed from the PDF on every fresh grading
-- session (an in-memory cache only survives one server process). This table
-- moves the work to answer-key CREATION: the PDF is parsed once at upload and
-- the text stored here, so grading reads it straight back with no re-parse.
--
-- It is a cache keyed by assignment_id and validated by source_path: replacing
-- the key (a new timestamped path) makes the stored text no longer match, so the
-- grader transparently re-parses and overwrites. Removing the key drops
-- settings.answerKeySource, after which the text is simply never read.
--
-- SENSITIVE: this is the answer key. Same posture as assignment_ai_grade_
-- suggestions — RLS ships here, staff SELECT only (their own section), NO student
-- policy, and NO write policy (writes go exclusively through the server-side
-- admin client). institution_id is always set server-side. The upsert conflict
-- key is assignment_id, a globally-unique UUID belonging to exactly one
-- institution, so tenant scoping of the key is inherent (data-access rule).

CREATE TABLE IF NOT EXISTS public.assignment_answer_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES public.assignments(id) ON DELETE CASCADE,
  -- Storage path + display name of the uploaded key PDF (settings.answerKeySource).
  source_path text NOT NULL,
  source_name text NOT NULL,
  -- Parsed, capped (~30k chars) plain text fed to the grading prompt.
  text text NOT NULL,
  char_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_assignment_answer_key_assignment UNIQUE (assignment_id)
);

COMMENT ON TABLE public.assignment_answer_keys IS
  'Staff-only parsed answer-key text, prepared once at upload. Never student-visible; a cache of the key PDF keyed by assignment_id, validated by source_path.';

CREATE INDEX IF NOT EXISTS idx_assignment_answer_keys_section
  ON public.assignment_answer_keys (section_id);
CREATE INDEX IF NOT EXISTS idx_assignment_answer_keys_institution
  ON public.assignment_answer_keys (institution_id);

ALTER TABLE public.assignment_answer_keys ENABLE ROW LEVEL SECURITY;

-- Staff SELECT only. No student policy. No write policy (admin client only) — a
-- FOR ALL policy would let a staff member rewrite the answer key straight through
-- PostgREST, bypassing the server action (security-migrations rule).
CREATE POLICY "Section owner/staff can read answer keys"
  ON public.assignment_answer_keys
  FOR SELECT
  TO authenticated
  USING (public.is_section_owner_or_staff(section_id));

-- Table privileges: authenticated may read (further constrained to staff by the
-- policy above); all writes go through the service-role admin client. anon gets
-- nothing.
GRANT SELECT ON public.assignment_answer_keys TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assignment_answer_keys TO service_role;
