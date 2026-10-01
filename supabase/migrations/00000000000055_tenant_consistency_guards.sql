-- Tenant consistency guards: enforce that transitive tagged tables carry the
-- same institution_id as their parent. Without this, a row could land with an
-- institution_id that disagrees with its parent's, leaking across tenants in
-- admin views that join through the parent (e.g. Stevens admin saw a
-- Scholera-Dev professor on a Stevens course because course_sections drifted).
--
-- Constraints enforced (BEFORE INSERT OR UPDATE):
--   courses.institution_id          == departments.institution_id (parent)
--   programs.institution_id         == departments.institution_id (parent)
--   course_sections.institution_id  == courses.institution_id     (parent)

CREATE OR REPLACE FUNCTION enforce_course_tenant_match()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_inst uuid;
BEGIN
  SELECT institution_id INTO parent_inst FROM departments WHERE id = NEW.department_id;
  IF parent_inst IS NULL THEN
    RAISE EXCEPTION 'Parent department % not found', NEW.department_id;
  END IF;
  IF NEW.institution_id <> parent_inst THEN
    RAISE EXCEPTION
      'Tenant mismatch: courses.institution_id (%) must equal departments.institution_id (%) for department %',
      NEW.institution_id, parent_inst, NEW.department_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_courses_tenant_match ON courses;
CREATE TRIGGER trg_courses_tenant_match
  BEFORE INSERT OR UPDATE OF institution_id, department_id ON courses
  FOR EACH ROW EXECUTE FUNCTION enforce_course_tenant_match();


CREATE OR REPLACE FUNCTION enforce_program_tenant_match()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_inst uuid;
BEGIN
  SELECT institution_id INTO parent_inst FROM departments WHERE id = NEW.department_id;
  IF parent_inst IS NULL THEN
    RAISE EXCEPTION 'Parent department % not found', NEW.department_id;
  END IF;
  IF NEW.institution_id <> parent_inst THEN
    RAISE EXCEPTION
      'Tenant mismatch: programs.institution_id (%) must equal departments.institution_id (%) for department %',
      NEW.institution_id, parent_inst, NEW.department_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_programs_tenant_match ON programs;
CREATE TRIGGER trg_programs_tenant_match
  BEFORE INSERT OR UPDATE OF institution_id, department_id ON programs
  FOR EACH ROW EXECUTE FUNCTION enforce_program_tenant_match();


CREATE OR REPLACE FUNCTION enforce_section_tenant_match()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_inst uuid;
BEGIN
  SELECT institution_id INTO parent_inst FROM courses WHERE id = NEW.course_id;
  IF parent_inst IS NULL THEN
    RAISE EXCEPTION 'Parent course % not found', NEW.course_id;
  END IF;
  IF NEW.institution_id <> parent_inst THEN
    RAISE EXCEPTION
      'Tenant mismatch: course_sections.institution_id (%) must equal courses.institution_id (%) for course %',
      NEW.institution_id, parent_inst, NEW.course_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_course_sections_tenant_match ON course_sections;
CREATE TRIGGER trg_course_sections_tenant_match
  BEFORE INSERT OR UPDATE OF institution_id, course_id ON course_sections
  FOR EACH ROW EXECUTE FUNCTION enforce_section_tenant_match();


-- Sanity gate: refuse to install if existing data already violates the rule.
-- Forces a data fix before the trigger lands.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM courses c JOIN departments d ON d.id = c.department_id
    WHERE c.institution_id <> d.institution_id
  ) THEN
    RAISE EXCEPTION 'Inconsistent courses.institution_id vs departments.institution_id — fix data before applying';
  END IF;
  IF EXISTS (
    SELECT 1 FROM programs p JOIN departments d ON d.id = p.department_id
    WHERE p.institution_id <> d.institution_id
  ) THEN
    RAISE EXCEPTION 'Inconsistent programs.institution_id vs departments.institution_id — fix data before applying';
  END IF;
  IF EXISTS (
    SELECT 1 FROM course_sections cs JOIN courses c ON c.id = cs.course_id
    WHERE cs.institution_id <> c.institution_id
  ) THEN
    RAISE EXCEPTION 'Inconsistent course_sections.institution_id vs courses.institution_id — fix data before applying';
  END IF;
END $$;
