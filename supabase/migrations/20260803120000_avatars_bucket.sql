-- Avatars bucket for user profile photos.
--
-- Previously this bucket was expected to be created BY HAND in the Supabase dashboard
-- (updateAvatar/removeAvatar in student/profile/actions.ts even error with a
-- "create it in Supabase Dashboard" hint). That meant profile-photo upload silently
-- failed in every environment where the manual step was missed. Provisioning it here
-- makes "change photo" work everywhere and keeps storage reproducible from migrations.
--
-- PUBLIC bucket (deliberate): avatar_url stores a getPublicUrl() link that is rendered
-- as a plain <img> across the app (header, cards, rosters) with no app session available
-- to re-sign a private URL. Avatars are low-sensitivity display images, not PII files.
--
-- Path layout: {userId}/avatar_{timestamp}.{ext}
-- All app writes go through the admin client (service_role bypasses RLS); the per-user
-- write policies below are the last line of defense against a direct browser storage call.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars',
  'avatars',
  true,
  5242880, -- 5 MB (matches the cap enforced in updateAvatar)
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- Read: public. Avatars are served from the public endpoint and rendered as <img> app-wide.
CREATE POLICY "Avatars: public read"
  ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'avatars');

-- Write: a user may only create/replace/delete objects under their own {userId}/ folder
-- (segment 1 = their uid). auth.uid() is wrapped in a scalar subquery per the RLS
-- init-plan advisor.
CREATE POLICY "Avatars: users write own folder"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (select auth.uid())::text
  );

CREATE POLICY "Avatars: users update own folder"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (select auth.uid())::text
  )
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (select auth.uid())::text
  );

CREATE POLICY "Avatars: users delete own folder"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (select auth.uid())::text
  );
