-- Live Classroom — allow PowerPoint source uploads in the deck bucket.
--
-- The deck bucket (mig 30) only permitted image/webp, image/png, and
-- application/pdf. PPTX/PPT support converts the source to PDF server-side
-- (via the Gotenberg converter), but the source file must FIRST land in this
-- bucket through the signed upload URL — so the bucket's allowed_mime_types
-- must include the Office MIME types or the PUT is rejected at the storage
-- layer (enforced regardless of the service-role client).
--
-- Deliberate mime-list widen. No new table → RLS unchanged (the bucket's
-- existing professor-upload / public-read policies from mig 30/49 still apply).

UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'image/webp',
  'image/png',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', -- .pptx
  'application/vnd.ms-powerpoint'                                              -- .ppt
]
WHERE id = 'live-classroom-decks';
