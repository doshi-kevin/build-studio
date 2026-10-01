# Hybrid Extraction + Citation — visual test (tables · figures · charts · citations)

**Target:** local dev (`localhost:3000`) + local Supabase, `EXTRACTION_V2_ENABLED=true`, real **Gemini** key in `.env.local`.
**Driver:** Chrome DevTools MCP — driver mechanics in [README.md](./README.md).
**Feature under test:** the full extraction→citation→visual chain on `feature/extraction-hybrid-citation` — design in `docs/designs/quizzes/hybrid-extraction-and-citation.md` (§1–14 extraction, §15 quiz citations + peek, §16 visual questions + tutor visuals + quiz uploads).
**Last run:** 2026-06-10 (full matrix — see run log at bottom). Prior run 2026-06-09 (table path only).

> Seed: `scripts/dev-setup/setup-local.sh` (professor@scholera.dev / student1@scholera.dev, pw `<password in .env.local>`, CS101). Fixtures: generate with `tmp/visual-fixtures/make-chart.mjs`-style scripts + LibreOffice (`soffice --convert-to pdf lecture.html`, `--convert-to 'docx:MS Word 2007 XML'`) + python-pptx for the deck; plus the camelot table PDFs in `src/__tests__/fixtures/tables/` (ruled `foo.pdf`, borderless `stream_inner_outer_columns.pdf`) and `fixtures/office/gen_chart.xlsx`.

---

## Coverage matrix (as of 2026-06-10 run)

✅ = verified in a recorded run · ◐ = partially verified (see note) · ☐ = not yet exercised · n/a = by design

| Unit kind | Extraction stored | Quiz citation + peek | Visual question (crop) | Tutor inline visual |
|---|---|---|---|---|
| **Table** (PDF ruled, lattice w/ bbox) | ✅ `geometric` + bbox (foo.pdf) | ✅ | ✅ tight crop | ✅ (Fuel Savings run, 06-09) |
| **Table** (PDF ruled, lattice-missed → VLM) | ✅ exact HTML, `vision`, **no bbox** | ✅ | ✅ **full-page fallback** (no bbox by design) | ✅ full-page embed |
| **Table** (PDF borderless) | ✅ `geometric` + bbox — stream claimed it (not VLM-flagged; deviation from §13.2, output correct) | ✅ | ✅ tight crop | ☐ |
| **Table** (PPTX native `a:tbl`) | ✅ `native` | ✅ peek = rendered slide (LibreOffice cache) | ✅ full-slide (no bbox) | ☐ (deck cited via chip, image not requested) |
| **Table** (DOCX native `w:tbl`) | ✅ `native` | ✅ cited, named-subject phrasing (peek not page-renderable — degrades) | n/a (not renderable) | n/a |
| **Figure** (PPTX, author descr) | ✅ `native` (**fixed this run** — was never emitted) | ✅ | ☐ | ✅ full-slide via `figure:2:0` |
| **Figure** (PDF, VLM-described) | ✅ accurate description | ✅ cited p.2 | ◐ model didn't tag it this run | ☐ |
| **Figure** (no descr → VLM) | ◐ fixture flaw: python-pptx auto-sets filename descr | ☐ | ☐ | ☐ |
| **Chart** (XLSX native data) | ✅ exact `(label,value)` CSV incl. formula-ref resolution | ✅ cites the workbook (**fixed this run** — was mis-attributed) | n/a (not page-renderable) | ☐ |
| **Chart** (raster in PDF → description) | ✅ description w/ exact values | ✅ | ◐ (same as PDF figure row) | ☐ |
| **Formula / code** | ✅ 4 formulas (math-gate fired on units/%) | ✅ cited as text | n/a | n/a |
| **Standalone image** (all `vision`) | ✅ description w/ exact chart values, `textStatus: skipped` | ☐ | ☐ | ☐ |

## A — Extraction (professor, per file type)

1. Upload each source file as Lecture Material in a CS101 module; watch the status reach **completed** (PDF/PPTX/DOCX/XLSX; image too).
2. Verify stored units with a **read-only** query (never insert):
   `select content->'extraction'->'tables', ->'figures', ->'charts' from module_items where id = …` — tables as HTML, figures with `description`, charts with `data` CSV; each unit carries `pageNumber` + `source` (+ `bbox` only for geometric/pdfjs-positioned units).
3. Spot-check `source` honesty: PPTX table = `native`, VLM-recovered table = `vision`, OOXML chart = `native`.

## B — Quiz citations + peek (§15)

1. Quizzes → New → Generate with AI → pick the uploaded files (all types appear since the source filter widened) → generate ~10 questions.
2. Every AI question that matches its source shows a **"Source · page N" chip**; a question with no overlap shows **no chip**.
3. Click a chip → the **right-side peek panel** renders the actual page (not a modal, no navigation).
4. PPTX source: first peek pays the LibreOffice conversion, later peeks are fast — confirms the derived-PDF cache.
5. Cross-file attribution: a question answerable only from the XLSX data must cite the **workbook**, not a wordier file (regression — see run log).

## C — Visual questions (§16, quiz)

1. Expect **~⅓ of questions visual**: the **cropped PNG of the real source region** renders on the question card (wizard + review + student player + results review).
2. Crop tightness depends on bbox: `geometric` tables → tight crop incl. caption; `vision` tables and PPTX units → **full page/slide fallback** (by design — no stored coordinates).
3. No `[ASSET …]` text anywhere in student-visible content.
4. Publish → student attempt: images render in the player; submit; results review shows them again.
5. Watch for **"shown" phrasing on questions with no visual** (prompt rule added this run reduces it; the model still occasionally violates — flag, don't block).

## D — AI tutor visuals + citation chips (§16, tutor)

1. As **student**, ask about a table topic ("What does the fuel savings by drive cycle table show?").
2. Reply embeds the **real visual inline** via durable ref (`/api/extraction/page?item=…&asset=kind:page:idx`); verify `img.complete && naturalWidth > 0`.
3. Inline citations render as **numbered chips** matching the Sources list, which is **collapsed by default** behind an "N sources" disclosure — expand it to check the numbering. Clicking a chip or a source row opens the **right-pane viewer** (no reload). Multi-source answers number chips across files, and a marker citing several pages (`[Deck, page 44, 51]`) yields one chip per page.
4. Ask for a PPTX figure by name → full-slide render via `asset=figure:N:idx` (exercises the descr→figures path).

## E — Ad-hoc quiz uploads (§16.5)

1. Drop a PDF into the AI-generate dialog → status badge reaches **READY** (small files parse before the first poll; bigger ones show Parsing).
2. Generate + save → Modules page: the file sits in hidden **"Quiz Uploads"** with the **"Quiz upload" badge** and provenance "Uploaded {date} for AI quiz generation · **Used by: {quiz title}**".
3. Re-open the generate dialog → the upload is reusable from the source tree ("Quiz Uploads N files" group).
4. Upload-sourced questions get citations and crops like module files (foo.pdf produced a tight lattice crop).

## F — Negative / trust-boundary checks

Run as the **student** via in-page `fetch` against `/api/extraction/page`:

| Probe | Expected | 2026-06-10 |
|---|---|---|
| visible item, `page=1` | 200 | ✅ 200 |
| hidden quiz-upload item | 403 | ✅ 403 |
| `page=99` (out of range) | 4xx | ✅ 404 |
| `asset=table:1:7` (no such idx) | 4xx | ✅ 404 |
| `asset=__junk__` (malformed) | 400 | ✅ 400 |
| random foreign UUID | 4xx | ✅ 404 |
| Quiz Uploads module in student modules HTML | absent | ✅ absent |

---

## Run log — 2026-06-10 (full matrix)

Fixtures: lecture.pdf (ruled table + raster chart figure), deck.pptx (native table + image w/ descr ×2 slides), report.docx (native table), chart.xlsx (native chart), enrollment-chart.png, + camelot borderless PDF. All six extracted to completion; 10-question quiz generated across all sources (3 with crops), published, attempted as student, tutor probed twice, upload pipeline + provenance verified, trust-boundary table all green. Frames in `tmp/run-frames/`, video `tmp/extraction-citation-e2e.webm` (transient — attach to PR, then delete).

**Bugs found & FIXED during the run:**
- **PPTX author alt-text never became figure units** — `extractPptx` stored `descr` only on `images[].altText`, which the asset registry doesn't read, so described PPTX figures were invisible to visual questions and the tutor (DOCX already did this right). Fixed: descr now also emits a `native` figure unit per slide (`pptx.ts`); verified live with `asset=figure:2:0` rendering in tutor chat.
- **Generate dialog hid DOCX/XLSX/image sources** — `getModulesWithExtraction` filtered to `pdf|ppt`, a leftover from before extended types. Widened to all completed v2 extractions; crops stay safe (`isRenderableSource` guards materialization).
- **XLSX-grounded questions mis-cited a wordier file** — content-overlap attribution only scored page *prose*, and a sheet has none, so "graduates in 2022?" cited the lecture PDF. Fixed: per-page matchable text now includes unit content (table cells, chart CSV, figure descriptions); re-run cited **Enrollment Data Workbook · p.1**.
- **"Based on the table shown" with no visual** — prompt rule added: "shown/below" phrasing only allowed with `sourceAssetId`; otherwise name the subject. Reduced but not eliminated (one XLSX chart question still violated — stochastic; logged as known limitation).

**Known limitations (by design or accepted):**
- ~~**VLM-recovered tables have no bbox** → full-page fallback~~ **FIXED post-run:** the vision schema now asks Gemini for each table's normalized bbox; `normalizedBboxToPoints` converts it to stored point-space with fail-soft validation (clamped into the page; degenerate/whole-page boxes rejected → full-page fallback, never a wrong slice). Verified live: the lecture's vision table re-extracted with a bbox and `asset=table:1:0` now renders the table region (851×598) instead of the full A4 page. Root cause of the lattice miss: this PDF draws cell borders with **zero stroke operators** (one path, fills only — LibreOffice HTML→PDF, camelot `background_lines` class), so the ruling-line detector correctly found nothing.
- The borderless camelot fixture was claimed confidently by the **stream** detector (`geometric` + bbox) instead of deferring to the VLM as §13.2's table says — output was a correct 6-col grid, so recorded as a deviation, not a bug.
- Gemini flash intermittently returns `AI_NoObjectGeneratedError` on large multi-source generations (2 consecutive failures ~150 s each, third attempt 10/10 in normal time). Retry is the professor-facing remedy.
- python-pptx auto-fills `descr` with the image filename, so a true "undescribed PPTX figure → VLM" fixture needs hand-built XML (still ☐ in the matrix).
