-- One default #general channel per section.
--
-- The professor sidebar now lists Discussions whether or not the feature has
-- been released to students, so the default channel is created on first visit
-- rather than only at toggle time. Two concurrent visits (a prefetch racing a
-- click) would otherwise both pass the existence check and insert. This index
-- makes the loser fail with 23505, which the app treats as success.
--
-- Partial: team channels and non-default course channels are unconstrained.
-- Verified against prod before writing: 0 sections currently hold more than one
-- default course channel, so this applies without a dedup step.
--
-- No RLS changes here — discussion_channels already has RLS enabled with its
-- existing section-scoped policies; this migration only adds an index.

create unique index if not exists discussion_channels_one_default_per_section
  on public.discussion_channels (section_id)
  where scope = 'course' and is_default = true;
