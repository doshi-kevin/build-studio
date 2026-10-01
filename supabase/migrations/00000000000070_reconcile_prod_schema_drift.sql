-- ============================================================================
-- Reconcile repo migrations with the live PROD schema.
--
-- PROD was hand-edited over time and those changes were never written back as
-- migrations, so a database built purely from migrations (staging, local dev,
-- CI) diverged from prod. This migration captures the prod-only objects so the
-- migrations become a faithful source of truth. Every function/trigger/policy/
-- constraint/index body below was extracted VERBATIM from prod
-- (pg_get_functiondef / pg_get_triggerdef / pg_get_constraintdef / pg_policies
-- / pg_indexes); the only edits are idempotency wrappers. PROD is already in
-- this state, so on PROD this migration is a near-no-op.
--
-- Apply order is dependency-driven: functions -> event trigger -> constraints
-- (drop->add) -> indexes (drop->create) -> triggers -> policies.
--
-- NOTE: the timestamptz->timestamp column-type divergence (~16 columns) is
-- deliberately NOT handled here. It is a separate decision (it downgrades the
-- migrations' timestamptz to prod's bare timestamp and forces full table
-- rewrites under ACCESS EXCLUSIVE locks on prod). See the team's follow-up.
-- ============================================================================


-- ============================================================================
-- 1) FUNCTIONS (exist in prod only; in no migration)
--    update_updated_at() and schedule_quiz_publish() back the triggers in
--    section 5; get_visible_profile_ids() backs the policy in section 6;
--    rls_auto_enable() backs the event trigger in section 2.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_dm_unread_counts(p_user_id uuid)
 RETURNS TABLE(other_user_id uuid, unread_count bigint, last_message_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT
    CASE WHEN ch.user_a_id = p_user_id THEN ch.user_b_id ELSE ch.user_a_id END AS other_user_id,
    COUNT(msg.id) AS unread_count,
    ch.last_message_at
  FROM dm_channels ch
  LEFT JOIN dm_read_cursors cur
    ON cur.channel_id = ch.id AND cur.user_id = p_user_id
  LEFT JOIN dm_messages msg
    ON msg.channel_id = ch.id
    AND msg.author_id != p_user_id
    AND msg.deleted_at IS NULL
    AND msg.created_at > COALESCE(cur.last_read_at, '1970-01-01'::timestamptz)
  WHERE ch.user_a_id = p_user_id OR ch.user_b_id = p_user_id
  GROUP BY ch.id, ch.user_a_id, ch.user_b_id, ch.last_message_at;
$function$;

CREATE OR REPLACE FUNCTION public.get_teammate_ids(p_user_id uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT DISTINCT pm2.user_id
  FROM project_members pm1
  JOIN project_members pm2 ON pm1.team_id = pm2.team_id
  WHERE pm1.user_id = p_user_id;
$function$;

CREATE OR REPLACE FUNCTION public.get_visible_profile_ids(p_user_id uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- Own profile
  SELECT p_user_id
  UNION
  -- Teammates
  SELECT DISTINCT pm2.user_id
  FROM project_members pm1
  JOIN project_members pm2 ON pm1.team_id = pm2.team_id
  WHERE pm1.user_id = p_user_id
  UNION
  -- Classmates (same enrolled section)
  SELECT DISTINCT e2.student_id
  FROM enrollments e1
  JOIN enrollments e2 ON e1.section_id = e2.section_id
  WHERE e1.student_id = p_user_id
  UNION
  -- Students enrolled in sections the user owns (professor sees their students)
  SELECT DISTINCT e.student_id
  FROM course_sections cs
  JOIN enrollments e ON e.section_id = cs.id
  WHERE cs.professor_id = p_user_id
  UNION
  -- Students/professors can see the professor of their enrolled sections
  SELECT DISTINCT cs.professor_id
  FROM enrollments e
  JOIN course_sections cs ON cs.id = e.section_id
  WHERE e.student_id = p_user_id
$function$;

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.schedule_quiz_publish()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  cron_expr TEXT;
  job_name TEXT;
BEGIN
  job_name := 'publish-quiz-' || NEW.id;

  -- Always cancel any existing pending publish job for this quiz
  BEGIN
    PERFORM cron.unschedule(job_name);
  EXCEPTION WHEN OTHERS THEN
    NULL; -- job didn't exist, that's fine
  END;

  -- Schedule a new one-time job only if a future scheduled time is set and quiz is draft
  IF NEW.scheduled_publish_at IS NOT NULL AND NEW.status = 'draft' THEN
    cron_expr := CONCAT(
      EXTRACT(MINUTE FROM NEW.scheduled_publish_at AT TIME ZONE 'UTC')::INT, ' ',
      EXTRACT(HOUR   FROM NEW.scheduled_publish_at AT TIME ZONE 'UTC')::INT, ' ',
      EXTRACT(DAY    FROM NEW.scheduled_publish_at AT TIME ZONE 'UTC')::INT, ' ',
      EXTRACT(MONTH  FROM NEW.scheduled_publish_at AT TIME ZONE 'UTC')::INT, ' *'
    );

    -- Cron job only does the UPDATE — no self-unschedule.
    -- The AFTER UPDATE trigger fires when scheduled_publish_at becomes NULL,
    -- which calls cron.unschedule() to clean up the job automatically.
    PERFORM cron.schedule(job_name, cron_expr, FORMAT(
      $sql$
        UPDATE quizzes
        SET status = 'published',
            scheduled_publish_at = NULL,
            updated_at = NOW()
        WHERE id = '%s'
          AND status = 'draft';
      $sql$,
      NEW.id
    ));
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$function$;


-- ============================================================================
-- 2) EVENT TRIGGER  (prod-only — THE root cause of the RLS drift)
--    Prod's "ensure_rls" event trigger auto-enables RLS on every new public
--    table via rls_auto_enable(). It was never in migrations, so from-migrations
--    builds didn't auto-protect new tables. Adding it here matches prod AND
--    prevents this class of drift going forward.
-- ============================================================================

DROP EVENT TRIGGER IF EXISTS ensure_rls;
CREATE EVENT TRIGGER ensure_rls ON ddl_command_end
  EXECUTE FUNCTION public.rls_auto_enable();


-- ============================================================================
-- 3) CONSTRAINTS
--    Prod uses different UNIQUE tuples than the migrations. Drop the
--    migration-only constraints, then add prod's (guarded NOT EXISTS = no-op
--    on prod). Constraint-backed uniques use ADD CONSTRAINT so the constraint
--    object — not just an index — is reproduced.
-- ============================================================================

ALTER TABLE public.courses     DROP CONSTRAINT IF EXISTS courses_code_key;
ALTER TABLE public.programs    DROP CONSTRAINT IF EXISTS programs_code_key;
ALTER TABLE public.enrollments DROP CONSTRAINT IF EXISTS enrollments_student_id_section_id_key;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='course_sections_course_id_section_code_semester_year_key' AND connamespace='public'::regnamespace) THEN
    ALTER TABLE public.course_sections ADD CONSTRAINT course_sections_course_id_section_code_semester_year_key UNIQUE (course_id, section_code, semester, year);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='courses_department_id_code_key' AND connamespace='public'::regnamespace) THEN
    ALTER TABLE public.courses ADD CONSTRAINT courses_department_id_code_key UNIQUE (department_id, code);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='enrollments_section_id_student_id_key' AND connamespace='public'::regnamespace) THEN
    ALTER TABLE public.enrollments ADD CONSTRAINT enrollments_section_id_student_id_key UNIQUE (section_id, student_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='profiles_cwid_key' AND connamespace='public'::regnamespace) THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_cwid_key UNIQUE (cwid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='profiles_email_key' AND connamespace='public'::regnamespace) THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_email_key UNIQUE (email);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='profiles_university_email_key' AND connamespace='public'::regnamespace) THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_university_email_key UNIQUE (university_email);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='programs_department_id_code_key' AND connamespace='public'::regnamespace) THEN
    ALTER TABLE public.programs ADD CONSTRAINT programs_department_id_code_key UNIQUE (department_id, code);
  END IF;
END $$;


-- ============================================================================
-- 4) INDEXES (plain, non-constraint-backed)
--    Drop migration-only indexes prod lacks; create prod-only perf indexes.
-- ============================================================================

DROP INDEX IF EXISTS public.idx_course_sections_course;
DROP INDEX IF EXISTS public.idx_course_sections_professor;
DROP INDEX IF EXISTS public.idx_enrollments_section;
DROP INDEX IF EXISTS public.idx_enrollments_student;
DROP INDEX IF EXISTS public.idx_events_user;
DROP INDEX IF EXISTS public.idx_profiles_email;
DROP INDEX IF EXISTS public.idx_profiles_role;

CREATE INDEX IF NOT EXISTS idx_announcements_author ON public.announcements USING btree (author_id);
CREATE INDEX IF NOT EXISTS idx_announcements_linked_items ON public.announcements USING gin (linked_items);
CREATE INDEX IF NOT EXISTS idx_course_sections_enrollment_dates ON public.course_sections USING btree (enrollment_start_date, enrollment_end_date);
CREATE INDEX IF NOT EXISTS idx_course_sections_status ON public.course_sections USING btree (status);
CREATE INDEX IF NOT EXISTS idx_events_section_id ON public.events USING btree (section_id);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON public.events USING btree ("timestamp");
CREATE INDEX IF NOT EXISTS idx_events_user_id ON public.events USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_module_items_module ON public.module_items USING btree (module_id);
CREATE INDEX IF NOT EXISTS idx_modules_section ON public.modules USING btree (section_id);
CREATE INDEX IF NOT EXISTS idx_quiz_answers_override ON public.quiz_answers USING btree (attempt_id) WHERE (override_points IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_quizzes_scheduled ON public.quizzes USING btree (scheduled_publish_at) WHERE ((status = 'draft'::text) AND (scheduled_publish_at IS NOT NULL));


-- ============================================================================
-- 5) TRIGGERS (prod-only; depend on functions in section 1)
-- ============================================================================

DROP TRIGGER IF EXISTS update_course_sections_updated_at ON public.course_sections;
CREATE TRIGGER update_course_sections_updated_at BEFORE UPDATE ON public.course_sections FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_courses_updated_at ON public.courses;
CREATE TRIGGER update_courses_updated_at BEFORE UPDATE ON public.courses FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_department_faculty_updated_at ON public.department_faculty;
CREATE TRIGGER update_department_faculty_updated_at BEFORE UPDATE ON public.department_faculty FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_departments_updated_at ON public.departments;
CREATE TRIGGER update_departments_updated_at BEFORE UPDATE ON public.departments FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_profiles_updated_at ON public.profiles;
CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_programs_updated_at ON public.programs;
CREATE TRIGGER update_programs_updated_at BEFORE UPDATE ON public.programs FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_schedule_quiz_publish ON public.quizzes;
CREATE TRIGGER trg_schedule_quiz_publish AFTER INSERT OR UPDATE OF scheduled_publish_at, status ON public.quizzes FOR EACH ROW EXECUTE FUNCTION schedule_quiz_publish();


-- ============================================================================
-- 6) RLS POLICIES on public.profiles
--    Migrations have a single "Users can view own profile" SELECT policy; prod
--    replaces it with own-profile + visible-profiles (via get_visible_profile_ids).
-- ============================================================================

DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;

DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
CREATE POLICY "Users can read own profile" ON public.profiles
  FOR SELECT TO public
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users can read visible profiles" ON public.profiles;
CREATE POLICY "Users can read visible profiles" ON public.profiles
  FOR SELECT TO public
  USING (id IN ( SELECT get_visible_profile_ids(auth.uid()) AS get_visible_profile_ids ));
