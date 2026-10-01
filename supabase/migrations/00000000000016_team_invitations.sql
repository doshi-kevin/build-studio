-- Migration: Team Invitations
-- Team leaders (owners) can send invitations to available classmates.
-- Invited students can accept or decline from the project page.

-- ── Table ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS team_invitations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       UUID NOT NULL REFERENCES project_teams(id) ON DELETE CASCADE,
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  section_id    UUID NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  invited_by    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  invited_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at  TIMESTAMPTZ,

  -- One pending/accepted invitation per user per team
  UNIQUE (team_id, invited_user_id)
);

-- ── Indexes ─────────────────────────────────────────────────────

CREATE INDEX idx_team_invitations_team ON team_invitations(team_id);
CREATE INDEX idx_team_invitations_invited_user ON team_invitations(invited_user_id, status);
CREATE INDEX idx_team_invitations_project ON team_invitations(project_id);

-- ── RLS ─────────────────────────────────────────────────────────

ALTER TABLE team_invitations ENABLE ROW LEVEL SECURITY;

-- Team members can see invitations sent by their team
CREATE POLICY "Team members can read team invitations"
  ON team_invitations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM project_members pm
      WHERE pm.team_id = team_invitations.team_id
        AND pm.user_id = auth.uid()
    )
  );

-- Invited users can see invitations sent to them
CREATE POLICY "Users can read their own invitations"
  ON team_invitations FOR SELECT
  USING (invited_user_id = auth.uid());

-- Team owners can send invitations (insert)
CREATE POLICY "Team owners can send invitations"
  ON team_invitations FOR INSERT
  WITH CHECK (
    invited_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM project_members pm
      WHERE pm.team_id = team_invitations.team_id
        AND pm.user_id = auth.uid()
        AND pm.role = 'owner'
    )
  );

-- Team owners can update (withdraw) invitations
CREATE POLICY "Team owners can update invitations"
  ON team_invitations FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM project_members pm
      WHERE pm.team_id = team_invitations.team_id
        AND pm.user_id = auth.uid()
        AND pm.role = 'owner'
    )
  );

-- Invited users can update (accept/decline) their invitations
CREATE POLICY "Invited users can respond to invitations"
  ON team_invitations FOR UPDATE
  USING (invited_user_id = auth.uid());

-- Team owners can delete invitations
CREATE POLICY "Team owners can delete invitations"
  ON team_invitations FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM project_members pm
      WHERE pm.team_id = team_invitations.team_id
        AND pm.user_id = auth.uid()
        AND pm.role = 'owner'
    )
  );
