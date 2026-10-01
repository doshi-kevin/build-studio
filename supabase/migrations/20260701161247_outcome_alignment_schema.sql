-- Migration: outcome alignment schema — ABET (and any standard) coverage model.
--
-- Slice 2a of the Outcomes Alignment feature (design: harshil/outcomes-alignment/).
-- Four tables + seed the ABET Engineering standard:
--   accreditation_standards  — a named standard (ABET seeded; institution_id NULL = global default)
--   accreditation_outcomes   — the standard's outcomes (the 7 ABET Student Outcomes)
--   accreditation_indicators — measurable performance indicators under each outcome (the layer the pipeline maps to)
--   course_outcome_alignments — per-(section, indicator, evidence) mapping the pipeline produces (draft → approved)
--
-- Security posture:
--   • Reference tables (standards/outcomes/indicators) are READ-ONLY to clients.
--     v1 exposes only GLOBAL rows (institution_id IS NULL) — safe, no cross-tenant
--     leak; institution-custom standards are a deliberate future extension (the
--     policies below will be widened then). Writes are seed/admin only.
--   • course_outcome_alignments is section-scoped (reuses is_section_owner_or_staff),
--     SELECT-only for clients; the pipeline (service role) and the approve server
--     action (admin client) are the only writers — no client write policy.

-- ══ 1. accreditation_standards ═════════════════════════════════
CREATE TABLE IF NOT EXISTS public.accreditation_standards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  version text NOT NULL,
  institution_id uuid REFERENCES public.institutions(id) ON DELETE CASCADE, -- NULL = global default
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- one standard per (name, version) globally, and per institution for custom ones.
  CONSTRAINT uq_standard_name_version UNIQUE (name, version, institution_id)
);

-- ══ 2. accreditation_outcomes ══════════════════════════════════
CREATE TABLE IF NOT EXISTS public.accreditation_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  standard_id uuid NOT NULL REFERENCES public.accreditation_standards(id) ON DELETE CASCADE,
  code text NOT NULL,           -- e.g. 'SO-1'
  name text NOT NULL,
  description text,
  order_index int NOT NULL DEFAULT 0,
  CONSTRAINT uq_outcome_code UNIQUE (standard_id, code)
);
CREATE INDEX IF NOT EXISTS idx_accreditation_outcomes_standard ON public.accreditation_outcomes (standard_id);

-- ══ 3. accreditation_indicators ════════════════════════════════
CREATE TABLE IF NOT EXISTS public.accreditation_indicators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outcome_id uuid NOT NULL REFERENCES public.accreditation_outcomes(id) ON DELETE CASCADE,
  code text NOT NULL,           -- e.g. 'PI 1.1'
  description text NOT NULL,
  order_index int NOT NULL DEFAULT 0,
  CONSTRAINT uq_indicator_code UNIQUE (outcome_id, code)
);
CREATE INDEX IF NOT EXISTS idx_accreditation_indicators_outcome ON public.accreditation_indicators (outcome_id);

-- ══ 4. course_outcome_alignments ═══════════════════════════════
CREATE TABLE IF NOT EXISTS public.course_outcome_alignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id uuid NOT NULL REFERENCES public.course_sections(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  indicator_id uuid NOT NULL REFERENCES public.accreditation_indicators(id) ON DELETE CASCADE,
  level text NOT NULL CHECK (level IN ('I', 'R', 'M')),
  -- Traceability: points at the real artifact this evidence came from.
  evidence_source_type text NOT NULL CHECK (evidence_source_type IN ('clo', 'assignment', 'quiz', 'module_item')),
  evidence_source_id uuid,
  evidence_text text,                          -- AI justification / professor note
  attainment numeric(5,2),                     -- median mastery % snapshot; null when unmeasured
  source text NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_course_outcome_alignments_section ON public.course_outcome_alignments (section_id);
CREATE INDEX IF NOT EXISTS idx_course_outcome_alignments_indicator ON public.course_outcome_alignments (indicator_id);
CREATE INDEX IF NOT EXISTS idx_course_outcome_alignments_institution ON public.course_outcome_alignments (institution_id);

-- ══ RLS ════════════════════════════════════════════════════════
ALTER TABLE public.accreditation_standards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accreditation_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accreditation_indicators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_outcome_alignments ENABLE ROW LEVEL SECURITY;

-- Reference tables: read-only, GLOBAL rows only in v1 (institution_id IS NULL).
-- No write policy → seed/admin only. Widen the standards predicate when
-- institution-custom standards ship.
CREATE POLICY "Anyone authenticated can read global standards"
  ON public.accreditation_standards FOR SELECT TO authenticated
  USING (institution_id IS NULL);

CREATE POLICY "Anyone authenticated can read global outcomes"
  ON public.accreditation_outcomes FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.accreditation_standards s
    WHERE s.id = standard_id AND s.institution_id IS NULL
  ));

CREATE POLICY "Anyone authenticated can read global indicators"
  ON public.accreditation_indicators FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.accreditation_outcomes o
    JOIN public.accreditation_standards s ON s.id = o.standard_id
    WHERE o.id = outcome_id AND s.institution_id IS NULL
  ));

-- Alignments: section staff (professor OR active staff) can read; no client
-- write path (pipeline + approve server action write via admin client).
CREATE POLICY "Section staff can read course outcome alignments"
  ON public.course_outcome_alignments FOR SELECT TO authenticated
  USING (public.is_section_owner_or_staff(section_id));

-- ══ Seed: ABET Engineering (EAC 2025-2026) ═════════════════════
-- Idempotent (ON CONFLICT DO NOTHING against the unique keys), so a re-apply
-- is a no-op. The 7 Student Outcomes are ABET's text; the 19 performance
-- indicators are the approved suggested-&-editable default set.

INSERT INTO public.accreditation_standards (name, version, institution_id, is_active)
VALUES ('ABET Engineering', 'EAC 2025-2026', NULL, true)
ON CONFLICT (name, version, institution_id) DO NOTHING;

INSERT INTO public.accreditation_outcomes (standard_id, code, name, description, order_index)
SELECT s.id, v.code, v.name, v.description, v.ord
FROM (SELECT id FROM public.accreditation_standards WHERE name = 'ABET Engineering' AND version = 'EAC 2025-2026' AND institution_id IS NULL) s,
(VALUES
  ('SO-1', 'Complex problem solving', 'Identify, formulate, and solve complex engineering problems by applying principles of engineering, science, and mathematics.', 1),
  ('SO-2', 'Engineering design', 'Apply engineering design to produce solutions that meet specified needs with consideration of public health, safety, and welfare, as well as global, cultural, social, environmental, and economic factors.', 2),
  ('SO-3', 'Communication', 'Communicate effectively with a range of audiences.', 3),
  ('SO-4', 'Ethics & professional responsibility', 'Recognize ethical and professional responsibilities in engineering situations and make informed judgments, considering the impact of engineering solutions in global, economic, environmental, and societal contexts.', 4),
  ('SO-5', 'Teamwork', 'Function effectively on a team whose members together provide leadership, create a collaborative environment, establish goals, plan tasks, and meet objectives.', 5),
  ('SO-6', 'Experimentation & data', 'Develop and conduct appropriate experimentation, analyze and interpret data, and use engineering judgment to draw conclusions.', 6),
  ('SO-7', 'Lifelong learning', 'Acquire and apply new knowledge as needed, using appropriate learning strategies.', 7)
) AS v(code, name, description, ord)
ON CONFLICT (standard_id, code) DO NOTHING;

INSERT INTO public.accreditation_indicators (outcome_id, code, description, order_index)
SELECT o.id, v.code, v.description, v.ord
FROM public.accreditation_outcomes o
JOIN public.accreditation_standards s ON s.id = o.standard_id AND s.institution_id IS NULL
  AND s.name = 'ABET Engineering' AND s.version = 'EAC 2025-2026'
JOIN (VALUES
  ('SO-1', 'PI 1.1', 'Identifies and formulates a complex engineering problem, stating relevant assumptions and constraints.', 1),
  ('SO-1', 'PI 1.2', 'Applies principles of mathematics, science, and engineering to model the problem.', 2),
  ('SO-1', 'PI 1.3', 'Solves the model and evaluates whether the result is reasonable.', 3),
  ('SO-2', 'PI 2.1', 'Translates specified needs into engineering requirements and design criteria.', 1),
  ('SO-2', 'PI 2.2', 'Generates and evaluates alternative solutions against multiple realistic constraints (health/safety/welfare + global, cultural, social, environmental, economic).', 2),
  ('SO-2', 'PI 2.3', 'Produces a design that meets the specified needs.', 3),
  ('SO-3', 'PI 3.1', 'Produces well-structured written documents appropriate to purpose and audience.', 1),
  ('SO-3', 'PI 3.2', 'Delivers a clear oral or visual presentation of technical work.', 2),
  ('SO-3', 'PI 3.3', 'Uses effective figures, tables, and diagrams to convey information.', 3),
  ('SO-4', 'PI 4.1', 'Identifies the ethical and professional issues in an engineering situation.', 1),
  ('SO-4', 'PI 4.2', 'Makes and justifies an informed judgment, considering global, economic, environmental, and societal impact.', 2),
  ('SO-5', 'PI 5.1', 'Fulfills individual responsibilities and contributes to shared team goals.', 1),
  ('SO-5', 'PI 5.2', 'Collaborates to establish goals, plan tasks, and meet objectives.', 2),
  ('SO-5', 'PI 5.3', 'Contributes to an inclusive, collaborative environment and/or provides leadership.', 3),
  ('SO-6', 'PI 6.1', 'Designs and conducts appropriate experimentation to answer a question.', 1),
  ('SO-6', 'PI 6.2', 'Analyzes and interprets data using appropriate methods.', 2),
  ('SO-6', 'PI 6.3', 'Draws conclusions supported by the data and engineering judgment.', 3),
  ('SO-7', 'PI 7.1', 'Identifies a knowledge gap and locates appropriate resources.', 1),
  ('SO-7', 'PI 7.2', 'Acquires and applies new knowledge using appropriate learning strategies.', 2)
) AS v(so_code, code, description, ord) ON o.code = v.so_code
ON CONFLICT (outcome_id, code) DO NOTHING;
