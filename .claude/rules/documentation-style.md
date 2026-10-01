---
paths:
  - "**/*.md"
---

# Documentation Style

Every `.md` file you write (README, `CONTEXT.md`, `docs/`, design docs, PR descriptions, code review comments) is read by a teammate, not the person who asked for it. Write it so someone who has never touched that code reads it once and knows what to do next — the way a person explains it to another person, not the way an AI summarizes it. Technical depth stays. Filler goes.

- **Name a thing, then say what it is.** "Row-level security, the Postgres feature that filters rows by user" beats "RLS-scoped tenant isolation." Don't assume the reader already knows the jargon.
- **Say what it does, not what it's called.** "Upload a `.pptx` and it comes back as a PDF" tells the reader everything. "The `ensurePdf()` abstraction handles conversion" tells them nothing.
- **One idea per sentence.** Three clauses stitched together with dashes and parentheses are really three sentences. Split them.
- **No em dashes, en dashes, or arrows in prose.** Restructure the sentence instead — they're the clearest tell that a machine wrote it.
- **Cut words that carry no information:** seamlessly, robust, comprehensive, leverage, utilize, "it's worth noting that," "in the world of X."
- **Don't pad for length or restate the obvious.** A comment or doc line that just repeats the code beneath it earns nothing — delete it.
- **The bar for done:** a teammate who has never seen this file reads it once and knows what to do next. If they'd have to come ask a question the doc should have answered, rewrite it — don't bolt on more words.
