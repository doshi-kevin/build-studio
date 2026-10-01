-- Course-wide skill library (issue #173, "course-wide concept library").
--
-- The gap it closes: `skills` is scoped to a course_section, so every new
-- offering of the same course starts from a blank list and the professor
-- re-curates concepts they already curated last semester.
--
-- SHAPE: a library, not a shared live list. `course_skills` holds the curated
-- concept names for a COURSE; `skills` stays exactly as it is — per-section,
-- per-professor, editable, and the only thing mastery ever scores. Two flows
-- connect them (src/lib/skills/library.ts):
--
--   publish : a section's tracked skills are upserted UP into the library.
--   seed    : a section with an EMPTY pool is filled DOWN from the library.
--
-- Why not repoint `skills.section_id` → `course_id` (the literal reading of
-- #173): two professors teaching different sections would then share one
-- editable list, so A's rename/delete would move B's mastery mid-semester, and
-- `skill_mastery`'s unique(student_id, skill_id) would collide for a student
-- enrolled in two sections of one course. The library keeps the reuse win and
-- drops both hazards.
--
-- Created: 2026-08-07

-- ── The library ──────────────────────────────────────────────────
-- Flat two-level hierarchy mirroring `skills` (main = parent_id null).
-- No `excluded` / `suppressed` / `placement_pinned`: those are per-section
-- curation state, not properties of the concept. Nothing here is scored.
create table if not exists public.course_skills (
  id              uuid primary key default gen_random_uuid(),
  course_id       uuid not null references public.courses(id) on delete cascade,
  institution_id  uuid not null references public.institutions(id) on delete restrict,
  parent_id       uuid references public.course_skills(id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 120),
  info            text,
  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_course_skills_course on public.course_skills(course_id);
create index if not exists idx_course_skills_parent on public.course_skills(parent_id);

-- One entry per concept per course, matched on the SAME canonical form the
-- application de-dups with — src/lib/skills/canonical.ts canonicalizeName is
-- `lower → NFKD → strip every non-alphanumeric`, and all three steps are
-- reproduced here (normalize/lower/regexp_replace are IMMUTABLE, so this is
-- index-legal). The NFKD step is not cosmetic: without it "café" canonicalises to
-- `cafe` in TypeScript but `caf` in Postgres, and the two layers would disagree
-- about what a duplicate is.
--
-- Expressed as a unique index rather than enforced only in code because publish
-- runs concurrently from any section of the course — two sections publishing
-- "Back-propagation" and "backpropagation" in the same second must collapse, not
-- race into two rows.
--
-- Deliberately course-wide, NOT per-parent: the section-level editor already
-- rejects a duplicate name anywhere in the section (issue #330, addSkill), so a
-- name is the identity of a concept here too.
create unique index if not exists idx_course_skills_canonical
  on public.course_skills (
    course_id,
    regexp_replace(lower(normalize(name, NFKD)), '[^a-z0-9]', '', 'g')
  );

alter table public.course_skills enable row level security;

-- READ-ONLY to client sessions, deliberately — the same shape
-- 20260707011157_topic_mastery_330_security_hardening.sql gave `skills`,
-- `activity_skills` and `skill_mastery`, and for the same reason: every write in
-- src/lib/skills/library.ts goes through the admin client after an authorization
-- check, so a client-reachable write policy grants nothing the app needs and
-- opens a direct PostgREST channel. Here that channel would be worse than on
-- `skills`, because the library FEEDS other sections: a TA on one section of the
-- course could DELETE entries another section still seeds from, or INSERT
-- concepts that land in a different professor's new section already tracked and
-- scored.
--
-- SELECT scope: professors who teach any section of the course, plus active TAs
-- on any of its sections. auth.uid() is a scalar subselect so the planner
-- evaluates it once per query (auth_rls_initplan advisor).
--
-- No student policy: the library is a professor-side authoring surface. Students
-- read `skills` / `skill_mastery` for their own section, which is unchanged.
-- Dropped first so the whole file stays re-runnable (every other statement here is
-- `if not exists`); a partial apply or a hand-run against a drifted DB would
-- otherwise fail on this line. Same drop-then-create shape as 20260707011157.
drop policy if exists "Course staff read the course skill library" on public.course_skills;
create policy "Course staff read the course skill library"
  on public.course_skills for select
  using (
    course_id in (
      select cs.course_id from public.course_sections cs
      where cs.professor_id = (select auth.uid())
    )
    or course_id in (
      select cs.course_id from public.course_sections cs
      join public.section_staff ss on ss.section_id = cs.id
      where ss.staff_id = (select auth.uid())
        and ss.status = 'active' and ss.ends_at > now() and ss.role = 'ta'
    )
  );

-- Belt and braces behind the SELECT-only policy: strip the DML grants outright,
-- so a future `for all` policy (or a default grant) can't quietly reopen the
-- write path. `public` is revoked alongside anon/authenticated — revoking only
-- the two roles leaves the grant reachable through PUBLIC.
revoke insert, update, delete on public.course_skills from public, anon, authenticated;

-- The tenant invariant the dropped WITH CHECK used to assert is not lost: the
-- only writer is library.ts, which stamps institution_id from the SAME
-- course_sections row it reads course_id from, and enforce_section_tenant_match()
-- (00000000000055) already forces course_sections.institution_id =
-- courses.institution_id. Likewise `parent_id` staying inside its own course is
-- guaranteed by the writer — publish only ever passes a parent id it just read
-- for this course — which is the same app-enforced discipline the two-level depth
-- limit on `skills` relies on.

-- ── Provenance link on the per-section row ───────────────────────
-- Which library entry a section skill came from (seed) or feeds (publish).
-- Nullable: a skill curated only in this section has no library entry yet, and
-- ON DELETE SET NULL means pruning the library never touches a live section.
-- This is what makes publish an UPSERT instead of an append — without it a
-- rename in the section would mint a second library row.
alter table public.skills
  add column if not exists library_skill_id uuid references public.course_skills(id) on delete set null;

create index if not exists idx_skills_library on public.skills(library_skill_id);

comment on table public.course_skills is
  'Course-wide curated skill library. Reusable across sections; never scored — mastery only ever reads public.skills.';
