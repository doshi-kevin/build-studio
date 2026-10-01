-- Harden Live Classroom RPC functions and storage bucket.
--
-- Issue 1: lc_send_event is SECURITY DEFINER but never had REVOKE EXECUTE,
-- so any authenticated user could call it to broadcast spoofed events to any
-- room. This migration revokes execute from public/authenticated/anon.
-- Triggers (lc_rooms_after_update) still work because they run as the table
-- owner (SECURITY DEFINER), bypassing function-level EXECUTE checks.
--
-- Issue 2: lc_user_can_access_room is SECURITY DEFINER and callable by any
-- user, leaking room membership information. The only legitimate callers are
-- the realtime.messages RLS policies, which evaluate as the subscribing user
-- via SECURITY DEFINER context — but the function itself doesn't need to be
-- directly callable. Revoking EXECUTE from end-user roles while keeping the
-- function intact for RLS policy evaluation (policies run with the privileges
-- of the table owner, not the session user).
--
-- Issue 3: live-classroom-decks bucket was public with an unauthenticated
-- SELECT policy, exposing lecture slides to anyone with the URL. This
-- migration makes the bucket private and restricts reads to the room's
-- professor or enrolled students.

-- ── Revoke execute on lc_send_event ─────────────────────────────────

REVOKE EXECUTE ON FUNCTION lc_send_event(uuid, text, jsonb, boolean, boolean) FROM public, authenticated, anon;

-- ── Revoke execute on lc_user_can_access_room ───────────────────────

REVOKE EXECUTE ON FUNCTION lc_user_can_access_room(uuid, uuid) FROM public, anon;

-- ── Harden live-classroom-decks storage bucket ──────────────────────

-- 1. Make the bucket private
UPDATE storage.buckets
SET public = false
WHERE id = 'live-classroom-decks';

-- 2. Drop the old unauthenticated SELECT policy
DROP POLICY IF EXISTS "Public read live-classroom-decks" ON storage.objects;

-- 3. Create a new policy that restricts reads to the room's professor or
--    enrolled students. The room ID is the first path segment of the object
--    name (e.g., "abc-123/slide-0.webp" → room ID "abc-123").
CREATE POLICY "Authorized read live-classroom-decks"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'live-classroom-decks'
    AND (
      -- Professor who owns the room
      EXISTS (
        SELECT 1 FROM lc_rooms r
        WHERE r.id = (string_to_array(name, '/'))[1]::uuid
          AND r.prof_id = auth.uid()
      )
      OR
      -- Enrolled student in the room's section
      EXISTS (
        SELECT 1 FROM lc_rooms r
        JOIN enrollments e ON e.section_id = r.section_id
        WHERE r.id = (string_to_array(name, '/'))[1]::uuid
          AND e.student_id = auth.uid()
          AND e.status IN ('enrolled', 'completed')
      )
    )
  );
