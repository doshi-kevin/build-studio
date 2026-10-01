-- Extends migration 55: ensure course_sections.professor_id belongs to the
-- same institution as the section. Without this, an admin (or a misbehaving
-- code path) could assign a professor from tenant A to a section in tenant B,
-- granting that professor RLS access to tenant B's students and content.
--
-- The existing trigger from mig 55 only verifies the section's parent course
-- alignment. This adds the professor check on the same trigger function.

CREATE OR REPLACE FUNCTION enforce_section_tenant_match()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_inst uuid;
  prof_inst   uuid;
BEGIN
  /* Parent course must match. */
  SELECT institution_id INTO parent_inst FROM courses WHERE id = NEW.course_id;
  IF parent_inst IS NULL THEN
    RAISE EXCEPTION 'Parent course % not found', NEW.course_id;
  END IF;
  IF NEW.institution_id <> parent_inst THEN
    RAISE EXCEPTION
      'Tenant mismatch: course_sections.institution_id (%) must equal courses.institution_id (%) for course %',
      NEW.institution_id, parent_inst, NEW.course_id;
  END IF;

  /* Professor (if assigned) must belong to the same tenant. */
  IF NEW.professor_id IS NOT NULL THEN
    SELECT institution_id INTO prof_inst FROM profiles WHERE id = NEW.professor_id;
    IF prof_inst IS NULL THEN
      RAISE EXCEPTION 'Professor profile % not found', NEW.professor_id;
    END IF;
    IF prof_inst <> NEW.institution_id THEN
      RAISE EXCEPTION
        'Tenant mismatch: professor.institution_id (%) must equal section.institution_id (%) for professor %',
        prof_inst, NEW.institution_id, NEW.professor_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

/* Re-create the trigger so it also fires when professor_id is updated. */
DROP TRIGGER IF EXISTS trg_course_sections_tenant_match ON course_sections;
CREATE TRIGGER trg_course_sections_tenant_match
  BEFORE INSERT OR UPDATE OF institution_id, course_id, professor_id ON course_sections
  FOR EACH ROW EXECUTE FUNCTION enforce_section_tenant_match();

/* Sanity gate: refuse install if existing data is already drifted. */
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM course_sections cs
    JOIN profiles p ON p.id = cs.professor_id
    WHERE p.institution_id <> cs.institution_id
  ) THEN
    RAISE EXCEPTION 'Existing course_sections.professor_id has cross-tenant assignment — fix data before applying';
  END IF;
END $$;
