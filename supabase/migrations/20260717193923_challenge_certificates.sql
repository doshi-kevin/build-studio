-- Slice B: professor-defined certificates for challenge milestones.
-- A certificate = a named set of challenges; completing ALL of them issues an
-- immutable, shareable credential to the student. Writes happen only through
-- server actions (admin client, bypasses RLS), so client policies are SELECT-only
-- (FOR ALL on a client-reachable table is a write-hole per security-migrations.md).

-- ── certificates: the professor-defined template ────────────────────────────
create table if not exists public.certificates (
  id              uuid primary key default gen_random_uuid(),
  section_id      uuid not null references public.course_sections(id) on delete cascade,
  institution_id  uuid not null references public.institutions(id) on delete restrict,
  created_by      uuid not null references public.profiles(id),
  title           text not null,
  description     text not null default '',
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_certificates_section on public.certificates(section_id);

alter table public.certificates enable row level security;

create policy "Professors and TAs read section certificates"
  on public.certificates for select
  using (
    section_id in (select id from public.course_sections where professor_id = (select auth.uid()))
    or section_id in (
      select section_id from public.section_staff
      where staff_id = (select auth.uid()) and status = 'active' and ends_at > now() and role = 'ta'
    )
  );

create policy "Enrolled students read active section certificates"
  on public.certificates for select
  using (
    is_active = true
    and section_id in (
      select section_id from public.enrollments
      where student_id = (select auth.uid()) and status in ('enrolled', 'completed')
    )
  );

-- ── certificate_challenges: which challenges compose a certificate ───────────
create table if not exists public.certificate_challenges (
  id              uuid primary key default gen_random_uuid(),
  certificate_id  uuid not null references public.certificates(id) on delete cascade,
  challenge_id    uuid not null references public.challenges(id) on delete cascade,
  section_id      uuid not null references public.course_sections(id) on delete cascade,
  institution_id  uuid not null references public.institutions(id) on delete restrict,
  created_at      timestamptz not null default now(),
  unique (certificate_id, challenge_id)
);
create index if not exists idx_cert_challenges_cert on public.certificate_challenges(certificate_id);
create index if not exists idx_cert_challenges_challenge on public.certificate_challenges(challenge_id);

alter table public.certificate_challenges enable row level security;

create policy "Professors and TAs read section certificate challenges"
  on public.certificate_challenges for select
  using (
    section_id in (select id from public.course_sections where professor_id = (select auth.uid()))
    or section_id in (
      select section_id from public.section_staff
      where staff_id = (select auth.uid()) and status = 'active' and ends_at > now() and role = 'ta'
    )
  );

create policy "Enrolled students read section certificate challenges"
  on public.certificate_challenges for select
  using (
    section_id in (
      select section_id from public.enrollments
      where student_id = (select auth.uid()) and status in ('enrolled', 'completed')
    )
    -- mirror the is_active gate on certificates: don't expose the composition of
    -- certificates the professor is still drafting.
    and certificate_id in (select id from public.certificates where is_active = true)
  );

-- ── student_certificates: the immutable issued-credential ledger ─────────────
-- certificate_id is RESTRICT: a certificate that has been earned cannot be
-- hard-deleted (that would 404 a student's live LinkedIn link). Display fields
-- are snapshotted at issue time so the public credential never changes if the
-- professor later edits the template.
create table if not exists public.student_certificates (
  id               uuid primary key default gen_random_uuid(),
  certificate_id   uuid not null references public.certificates(id) on delete restrict,
  section_id       uuid not null references public.course_sections(id) on delete cascade,
  institution_id   uuid not null references public.institutions(id) on delete restrict,
  student_id       uuid not null references public.profiles(id) on delete cascade,
  public_id        text not null unique,
  title            text not null,
  description      text not null default '',
  skills_snapshot  jsonb not null default '[]'::jsonb,
  issued_at        timestamptz not null default now(),
  seen_at          timestamptz,
  revoked_at       timestamptz,
  unique (certificate_id, student_id)
);
create index if not exists idx_student_certs_student on public.student_certificates(student_id);
create index if not exists idx_student_certs_certificate on public.student_certificates(certificate_id);
create index if not exists idx_student_certs_section on public.student_certificates(section_id);

alter table public.student_certificates enable row level security;

create policy "Students read their own certificates"
  on public.student_certificates for select
  using (student_id = (select auth.uid()));

create policy "Professors and TAs read section issued certificates"
  on public.student_certificates for select
  using (
    section_id in (select id from public.course_sections where professor_id = (select auth.uid()))
    or section_id in (
      select section_id from public.section_staff
      where staff_id = (select auth.uid()) and status = 'active' and ends_at > now() and role = 'ta'
    )
  );
-- NOTE: no anon/public policy. The public certificate page reads via the admin
-- client and returns only a sanitized DTO (never the raw row).

-- ── issue_certificates_for_challenge: atomic, race-safe issuance ─────────────
-- Called from reviewClaim after an approval. Locks the student's enrollment row
-- FOR UPDATE so two concurrent approvals for the SAME student serialize — this
-- closes the double-approval race where each txn counts only its own claim and
-- neither reaches the threshold. Returns the rows it newly issued so the caller
-- can fire one notification per genuinely-new credential (idempotent).
create or replace function public.issue_certificates_for_challenge(
  p_section_id uuid,
  p_student_id uuid,
  p_challenge_id uuid
)
returns table (id uuid, public_id text, title text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
  v_required int;
  v_have int;
  v_skills jsonb;
  v_new_id uuid;
  v_public text;
  v_title text;
begin
  -- Serialize per-student issuance (see header). Lock the student's profile row
  -- (a FK target that always exists) rather than the enrollment: a FOR UPDATE on a
  -- 0-row result acquires no lock, which would silently reopen the double-approval race.
  perform 1 from public.profiles where public.profiles.id = p_student_id for update;

  for c in
    select cert.id, cert.title, cert.description, cert.institution_id
    from public.certificates cert
    join public.certificate_challenges cch on cch.certificate_id = cert.id
    where cert.section_id = p_section_id
      and cert.is_active = true
      and cch.challenge_id = p_challenge_id
      and not exists (
        select 1 from public.student_certificates sc
        where sc.certificate_id = cert.id and sc.student_id = p_student_id
      )
  loop
    select count(*) into v_required
      from public.certificate_challenges where certificate_id = c.id;

    select count(distinct cch.challenge_id) into v_have
      from public.certificate_challenges cch
      join public.challenge_claims cl on cl.challenge_id = cch.challenge_id
      where cch.certificate_id = c.id
        and cl.user_id = p_student_id
        and cl.status = 'approved';

    if v_required > 0 and v_have >= v_required then
      select coalesce(jsonb_agg(distinct s.name), '[]'::jsonb) into v_skills
        from public.certificate_challenges cch
        join public.activity_skills a
          on a.activity_type = 'challenge' and a.activity_id = cch.challenge_id
        join public.skills s on s.id = a.skill_id
        where cch.certificate_id = c.id;

      insert into public.student_certificates (
        certificate_id, section_id, institution_id, student_id,
        public_id, title, description, skills_snapshot
      ) values (
        c.id, p_section_id, c.institution_id, p_student_id,
        replace(gen_random_uuid()::text, '-', ''), c.title, c.description, coalesce(v_skills, '[]'::jsonb)
      )
      on conflict (certificate_id, student_id) do nothing
      returning student_certificates.id, student_certificates.public_id, student_certificates.title
        into v_new_id, v_public, v_title;

      if v_new_id is not null then
        id := v_new_id;
        public_id := v_public;
        title := v_title;
        return next;
      end if;
    end if;
  end loop;
end;
$$;

-- Server-only: this issues credentials, so it must never be client-callable
-- (a student could otherwise forge their own). Only the service-role admin client.
revoke all on function public.issue_certificates_for_challenge(uuid, uuid, uuid) from public;
revoke all on function public.issue_certificates_for_challenge(uuid, uuid, uuid) from anon;
revoke all on function public.issue_certificates_for_challenge(uuid, uuid, uuid) from authenticated;
grant execute on function public.issue_certificates_for_challenge(uuid, uuid, uuid) to service_role;
