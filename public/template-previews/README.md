# Template Preview Screenshots

Screenshots shown in the TemplateMarketplace card thumb strips.

## How to add a preview

1. Open the studio for the template you want to capture.
2. Set your browser window to around 640px wide (or screenshot and crop to that width).
3. Take a screenshot of the top ~200px of the canvas (the part visible above the fold).
4. Save it as `{templateId}.png` in this directory.
5. In `src/lib/assignments/studio/marketplace-catalog.ts`, add `previewSrc: '/template-previews/{templateId}.png'` to the template entry in `MARKETPLACE_TEMPLATES` (or patch `SUBJECT_BY_ID` mapping as needed).

## Naming

Template IDs come from `SUBJECT_BY_ID` in `marketplace-catalog.ts`. Current IDs:

- `blank`
- `ml-assignment`
- `data-science`
- `stem-maths`
- `stem-physics`
- `stem-chemistry`
- `stem-biology`

## Fallback

Cards without a `previewSrc` automatically show the faux-preview bars — no breakage if a file is missing.
