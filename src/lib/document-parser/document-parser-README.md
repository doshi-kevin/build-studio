# Document Parser

Extracts text content from uploaded PDF and PPTX documents using officeparser. Runs server-side after a professor uploads a lecture file.

| File | Purpose |
|------|---------|
| `index.ts` | Core parsing logic: `parseDocument()` transforms buffer into structured extraction data; `downloadFileBuffer()` fetches files from Supabase Storage |
| `utils.ts` | Helpers: AST-to-text extraction, word counting, heading extraction, file type guards |
