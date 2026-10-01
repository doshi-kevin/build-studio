-- Weighted Gradebook — grading schemes, weighted categories, memberships, exceptions
--
-- Turns the manual final grade (enrollments.final_grade/final_score, typed by hand) into a
-- weighted grade computed from real assignment/quiz/project scores. A section has ONE grading
-- scheme made of weighted CATEGORIES. Each category aggregates its member items in one of three
-- ways (average / best-of-N / single). Every graded item belongs to exactly one category.
--
--   grading_schemes      — one row per section; holds section-level letter cutoffs
--   grade_categories     — weighted buckets within a scheme
--   grade_category_items — which item (assignment|quiz|project) sits in which category (1:1 per item)
--   grade_exceptions     — per-student per-item overrides (v1: 'excused' = drop from that student's grade)
--
-- The manual override stays where it is: enrollments.final_grade / final_score. When present it
-- wins over the computed value (shown in the UI, never silent). No new column needed for it.
--
-- SECURITY: these tables are written ONLY server-side via the admin client (service_role bypasses
-- RLS) from the professor grade actions. The authenticated role therefore gets SELECT-only policies
-- (a FOR ALL policy would let a student rewrite their own scheme/weights/exceptions straight through
-- PostgREST — see PR #198). Staff read their section's rows; students read the scheme + categories +
-- items for sections they're enrolled in (needed to render their own grade breakdown) and only their
-- OWN exception rows. institution_id is carried on every table for tenant scoping.

-- ── 1. Grading scheme (one per section) ──────────────────────────
CREATE TABLE IF NOT EXISTS public.grading_schemes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id uuid NOT NULL UNIQUE REFERENCES public.course_sections(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  -- letter_cutoffs: descending [{ "letter": "A+", "min": 97 }, ...]; validated app-side.
  -- Empty array = fall back to the standard scale defined in code.
  letter_cutoffs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grading_schemes_institution
  ON public.grading_schemes(institution_id);

-- ── 2. Weighted categories ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.grade_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scheme_id uuid NOT NULL REFERENCES public.grading_schemes(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- percent of the final grade; >100 total is allowed (warned in UI, e.g. extra-credit category)
  weight numeric(6,2) NOT NULL DEFAULT 0 CHECK (weight >= 0 AND weight <= 1000),
  aggregation text NOT NULL DEFAULT 'average'
    CHECK (aggregation IN ('average', 'best_of_n', 'single')),
  -- best_of_n only: how many top items to keep (rank by %). NULL for other modes.
  keep_n integer CHECK (keep_n IS NULL OR keep_n >= 0),
  -- how member items combine into the category score
  score_mode text NOT NULL DEFAULT 'points' CHECK (score_mode IN ('points', 'equal')),
  -- an extra-credit category adds to the numerator without being required to sum into 100%
  is_extra_credit boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grade_categories_scheme ON public.grade_categories(scheme_id);
CREATE INDEX IF NOT EXISTS idx_grade_categories_section ON public.grade_categories(section_id);

-- ── 3. Category membership (each item in exactly one category) ────
CREATE TABLE IF NOT EXISTS public.grade_category_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES public.grade_categories(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  item_type text NOT NULL CHECK (item_type IN ('assignment', 'quiz', 'project')),
  -- polymorphic id (assignments.id | quizzes.id | projects.id). Cannot FK to one table, so
  -- orphans are filtered at read time and cleaned up when the source item is deleted.
  item_id uuid NOT NULL,
  -- item-level extra credit: its earned points add to the category numerator, not the denominator
  is_extra_credit boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- an item can live in only one category within a section
  UNIQUE (section_id, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_grade_category_items_category ON public.grade_category_items(category_id);
CREATE INDEX IF NOT EXISTS idx_grade_category_items_section ON public.grade_category_items(section_id);

-- ── 4. Per-student item exceptions (v1: excused) ─────────────────
CREATE TABLE IF NOT EXISTS public.grade_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id uuid NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  item_type text NOT NULL CHECK (item_type IN ('assignment', 'quiz', 'project')),
  item_id uuid NOT NULL,
  -- 'excused' removes the item from that student's grade entirely (not a 0, not a drop)
  status text NOT NULL DEFAULT 'excused' CHECK (status IN ('excused')),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (section_id, student_id, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_grade_exceptions_section_student
  ON public.grade_exceptions(section_id, student_id);
-- student SELECT policy filters on student_id (leading column not covered by the composite)
CREATE INDEX IF NOT EXISTS idx_grade_exceptions_student ON public.grade_exceptions(student_id);

-- ── 5. updated_at triggers (shared function from migration 44) ────
CREATE OR REPLACE TRIGGER update_grading_schemes_updated_at BEFORE UPDATE ON public.grading_schemes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE OR REPLACE TRIGGER update_grade_categories_updated_at BEFORE UPDATE ON public.grade_categories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── 6. Row Level Security ────────────────────────────────────────
ALTER TABLE public.grading_schemes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grade_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grade_category_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grade_exceptions ENABLE ROW LEVEL SECURITY;

-- Reusable predicates, inlined per policy (Postgres has no shared macro):
--   staff  : section owned by the caller (professor) OR active TA/grader on it
--   student: caller is enrolled in the section

-- grading_schemes -------------------------------------------------
DROP POLICY IF EXISTS "Staff read section grading scheme" ON public.grading_schemes;
CREATE POLICY "Staff read section grading scheme"
  ON public.grading_schemes FOR SELECT
  USING (
    section_id IN (SELECT id FROM public.course_sections WHERE professor_id = (SELECT auth.uid()))
    OR section_id IN (
      SELECT section_id FROM public.section_staff
      WHERE staff_id = (SELECT auth.uid()) AND status = 'active' AND ends_at > now()
    )
  );
DROP POLICY IF EXISTS "Students read enrolled section grading scheme" ON public.grading_schemes;
CREATE POLICY "Students read enrolled section grading scheme"
  ON public.grading_schemes FOR SELECT
  USING (
    section_id IN (
      SELECT section_id FROM public.enrollments
      WHERE student_id = (SELECT auth.uid()) AND status IN ('enrolled', 'completed', 'active')
    )
  );

-- grade_categories ------------------------------------------------
DROP POLICY IF EXISTS "Staff read section grade categories" ON public.grade_categories;
CREATE POLICY "Staff read section grade categories"
  ON public.grade_categories FOR SELECT
  USING (
    section_id IN (SELECT id FROM public.course_sections WHERE professor_id = (SELECT auth.uid()))
    OR section_id IN (
      SELECT section_id FROM public.section_staff
      WHERE staff_id = (SELECT auth.uid()) AND status = 'active' AND ends_at > now()
    )
  );
DROP POLICY IF EXISTS "Students read enrolled section grade categories" ON public.grade_categories;
CREATE POLICY "Students read enrolled section grade categories"
  ON public.grade_categories FOR SELECT
  USING (
    section_id IN (
      SELECT section_id FROM public.enrollments
      WHERE student_id = (SELECT auth.uid()) AND status IN ('enrolled', 'completed', 'active')
    )
  );

-- grade_category_items --------------------------------------------
DROP POLICY IF EXISTS "Staff read section grade category items" ON public.grade_category_items;
CREATE POLICY "Staff read section grade category items"
  ON public.grade_category_items FOR SELECT
  USING (
    section_id IN (SELECT id FROM public.course_sections WHERE professor_id = (SELECT auth.uid()))
    OR section_id IN (
      SELECT section_id FROM public.section_staff
      WHERE staff_id = (SELECT auth.uid()) AND status = 'active' AND ends_at > now()
    )
  );
DROP POLICY IF EXISTS "Students read enrolled section grade category items" ON public.grade_category_items;
CREATE POLICY "Students read enrolled section grade category items"
  ON public.grade_category_items FOR SELECT
  USING (
    section_id IN (
      SELECT section_id FROM public.enrollments
      WHERE student_id = (SELECT auth.uid()) AND status IN ('enrolled', 'completed', 'active')
    )
  );

-- grade_exceptions ------------------------------------------------
DROP POLICY IF EXISTS "Staff read section grade exceptions" ON public.grade_exceptions;
CREATE POLICY "Staff read section grade exceptions"
  ON public.grade_exceptions FOR SELECT
  USING (
    section_id IN (SELECT id FROM public.course_sections WHERE professor_id = (SELECT auth.uid()))
    OR section_id IN (
      SELECT section_id FROM public.section_staff
      WHERE staff_id = (SELECT auth.uid()) AND status = 'active' AND ends_at > now()
    )
  );
DROP POLICY IF EXISTS "Students read own grade exceptions" ON public.grade_exceptions;
CREATE POLICY "Students read own grade exceptions"
  ON public.grade_exceptions FOR SELECT
  USING (student_id = (SELECT auth.uid()));

-- ── 7. Table privileges ──────────────────────────────────────────
-- Admin client (service_role) does all writes + reads; authenticated reads via the RLS policies
-- above. Granted explicitly so the migration works under a raw apply as well as Supabase's pipeline.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.grading_schemes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.grade_categories TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.grade_category_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.grade_exceptions TO service_role;
GRANT SELECT ON public.grading_schemes TO authenticated;
GRANT SELECT ON public.grade_categories TO authenticated;
GRANT SELECT ON public.grade_category_items TO authenticated;
GRANT SELECT ON public.grade_exceptions TO authenticated;
