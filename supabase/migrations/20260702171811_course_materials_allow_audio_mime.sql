-- Verbal Assessment "Generate audio" (issue #317): allow synthesized MP3 uploads.
--
-- generateVerbalQuestionAudio uploads the ElevenLabs MP3 to the course-materials bucket with
-- contentType 'audio/mpeg', but the bucket's allowed_mime_types has no audio/* entry (PDF/Office/
-- text/epub + images + video only), so Storage rejects the PUT ("mime type audio/mpeg is not
-- supported") and the cell never gets an audioPath. Add the audio MIME types so the upload lands.
--
-- Deliberate mime-list widen (same shape as mig 072). No new table -> RLS unchanged; the bucket's
-- existing professor-upload / section-read policies still apply. Idempotent + order-independent:
-- appends the audio types to whatever the list currently holds and de-dupes.

UPDATE storage.buckets
SET allowed_mime_types = ARRAY(
  SELECT DISTINCT mime
  FROM unnest(allowed_mime_types || ARRAY['audio/mpeg', 'audio/mp3']) AS mime
)
WHERE id = 'course-materials'
  AND allowed_mime_types IS NOT NULL;
