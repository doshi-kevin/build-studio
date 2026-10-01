-- Live Classroom — Bump live-classroom-decks bucket file_size_limit
-- to 250 MB so professors can upload large lecture PDFs (200-page
-- image-heavy decks). Pairs with MAX_DECK_BYTES in
-- src/lib/validations/live-classroom.ts.
--
-- Original limit (mig 30) was 50 MB, which would now reject the very
-- uploads the new direct-to-storage flow is built to handle.

UPDATE storage.buckets
SET file_size_limit = 262144000  -- 250 MiB (250 * 1024 * 1024)
WHERE id = 'live-classroom-decks';
