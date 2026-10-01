-- Base schema for Scholera LMS — creates all foundational tables
-- that the feature migration scripts depend on.
-- Column definitions match the production Supabase database (types.ts is ground truth).

-- ── Profiles ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text,
  first_name text,
  last_name text,
  role text NOT NULL DEFAULT 'student',
  avatar_url text,
  phone text,
  cwid text,
  university_email text,
  status text DEFAULT 'active',
  settings jsonb,
  onboarding_completed boolean DEFAULT false,
  invited_by uuid,
  invited_at timestamptz,
  invite_status text,
  invite_accepted_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'role', 'student')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ── Departments ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text NOT NULL UNIQUE,
  description text,
  contact_email text,
  contact_phone text,
  office_location text,
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ── Department Faculty ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS department_faculty (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid REFERENCES departments(id) ON DELETE CASCADE,
  professor_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  role text DEFAULT 'member',
  title text,
  position text,
  employment_type text,
  bio text,
  research_interests jsonb,
  office_location text,
  office_phone text,
  office_hours text,
  website_url text,
  linkedin_url text,
  resume_url text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  zip_code text,
  country text,
  status text,
  is_primary_department boolean,
  joined_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(department_id, professor_id)
);

-- ── Programs ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text NOT NULL UNIQUE,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  director_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  degree_type text,
  description text,
  total_credits integer,
  duration_semesters integer,
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ── Courses ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  code text NOT NULL UNIQUE,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  description text,
  credits integer,
  level text,
  prerequisites jsonb,
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ── Course Sections ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS course_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid REFERENCES courses(id) ON DELETE SET NULL,
  professor_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  section_code text NOT NULL,
  semester text NOT NULL,
  year integer NOT NULL,
  start_date date,
  end_date date,
  enrollment_start_date date,
  enrollment_end_date date,
  max_students integer,
  location text,
  modality text DEFAULT 'in_person',
  schedule jsonb,
  settings jsonb,
  status text DEFAULT 'active',
  archived_at timestamptz,
  ta_ids jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ── Enrollments ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  section_id uuid REFERENCES course_sections(id) ON DELETE CASCADE,
  status text DEFAULT 'enrolled',
  enrolled_at timestamptz DEFAULT now(),
  final_grade text,
  final_score numeric,
  UNIQUE(student_id, section_id)
);

-- ── Announcements ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title text NOT NULL,
  content text DEFAULT '',
  rich_content jsonb,
  is_pinned boolean DEFAULT false,
  published_at timestamptz DEFAULT now(),
  attachments jsonb DEFAULT '[]',
  links jsonb DEFAULT '[]',
  linked_items jsonb,
  scheduled_at timestamptz,
  status text DEFAULT 'published',
  visibility text DEFAULT 'all',
  allow_reactions boolean NOT NULL DEFAULT false,
  allow_comments boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ── Modules ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS modules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text DEFAULT '',
  instructor_note text DEFAULT '',
  position integer DEFAULT 0,
  is_published boolean DEFAULT false,
  unlock_date timestamptz,
  week_number integer,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ── Module Items ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS module_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  title text DEFAULT '',
  item_type text NOT NULL,
  description text DEFAULT '',
  instructor_note text DEFAULT '',
  content jsonb,
  position integer DEFAULT 0,
  is_visible boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ── Events (audit log) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  event_category text,
  section_id uuid,
  metadata jsonb,
  ip_address inet,
  user_agent text,
  device_type text,
  page_url text,
  session_id text,
  timestamp timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

-- ── Indexes ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);
CREATE INDEX IF NOT EXISTS idx_course_sections_professor ON course_sections(professor_id);
CREATE INDEX IF NOT EXISTS idx_course_sections_course ON course_sections(course_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_section ON enrollments(section_id);
CREATE INDEX IF NOT EXISTS idx_announcements_section ON announcements(section_id);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
