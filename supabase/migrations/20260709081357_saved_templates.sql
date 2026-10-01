-- Saved assignment templates: a professor's personal favourites in the Template Marketplace.
-- A row = "user U saved template T". template_id is TEXT because it holds either a built-in
-- scaffold id ('ml-assignment', 'stem-maths') or a past assignment's uuid (the professor's own
-- template) — the marketplace resolves the id against those two pools client-side.
--
-- Writes happen ONLY through the setTemplateSaved server action (admin client, after
-- verifySectionAccess). There is intentionally NO client write policy: per PR #198, a FOR ALL
-- policy scoped to owner_id would let the owner write any column straight through PostgREST.
-- The one policy below is SELECT-only so the New Assignment page can read the caller's own
-- favourites under RLS; all mutation goes through the admin client which bypasses RLS.

CREATE TABLE IF NOT EXISTS public.saved_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  template_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One save per (user, template). user_id is the tenant-scoping column here (a user belongs to
  -- exactly one institution), so this is the natural dedup key for the action's ON CONFLICT.
  UNIQUE (user_id, template_id)
);

-- RLS filters and the read query both key on user_id.
CREATE INDEX IF NOT EXISTS idx_saved_templates_user ON public.saved_templates(user_id);

ALTER TABLE public.saved_templates ENABLE ROW LEVEL SECURITY;

-- Read-only for the owner. No INSERT/UPDATE/DELETE policy → no client write path.
CREATE POLICY "Users can read their own saved templates"
  ON public.saved_templates FOR SELECT
  USING (user_id = (select auth.uid()));
