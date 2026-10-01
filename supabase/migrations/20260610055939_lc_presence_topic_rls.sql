-- Live Classroom presence topic — authorization for the "N students present"
-- live count on the professor's dashboard.
--
-- Presence rides its OWN topic `room:<uuid>:presence`, separate from the two
-- broadcast topics (`room:<uuid>` authoritative, `room:<uuid>:ephem`). This is
-- deliberate: realtime-js dedups channels by topic, so a presence channel that
-- shared the authoritative/ephemeral topic would collide with the broadcast
-- channel's config. A dedicated topic keeps presence fully isolated.
--
-- Supabase maps Presence to realtime.messages:
--   • receiving the presence roster (sync) = SELECT
--   • track() (announcing yourself)        = INSERT with extension = 'presence'
-- so this needs both a read and a presence-only write policy. Both reuse the
-- existing lc_user_can_access_room() gate (room professor OR enrolled student),
-- identical in shape to the broadcast-topic policies in migration 34. The
-- INSERT is further restricted to extension = 'presence' (least privilege —
-- a client can announce presence but cannot broadcast arbitrary messages on
-- this topic).

DROP POLICY IF EXISTS "lc room presence read access" ON realtime.messages;
CREATE POLICY "lc room presence read access"
  ON realtime.messages FOR SELECT
  TO authenticated
  USING (
    (realtime.topic() ~ '^room:[0-9a-f-]{36}:presence$')
    AND lc_user_can_access_room(
      (SELECT auth.uid()),
      (regexp_match(realtime.topic(), '^room:([0-9a-f-]{36}):presence$'))[1]::uuid
    )
  );

DROP POLICY IF EXISTS "lc room presence write access" ON realtime.messages;
CREATE POLICY "lc room presence write access"
  ON realtime.messages FOR INSERT
  TO authenticated
  WITH CHECK (
    (realtime.topic() ~ '^room:[0-9a-f-]{36}:presence$')
    AND extension = 'presence'
    AND lc_user_can_access_room(
      (SELECT auth.uid()),
      (regexp_match(realtime.topic(), '^room:([0-9a-f-]{36}):presence$'))[1]::uuid
    )
  );
