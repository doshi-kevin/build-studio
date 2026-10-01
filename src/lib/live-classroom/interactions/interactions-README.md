# Live Classroom Interactions

Phase 2 of the broadcast migration. Generic interactions + responses model that hosts polls, quizzes, and Q&A.

| File | Purpose |
|------|---------|
| `actions.ts` | Server actions: `createInteraction`, `openInteraction`, `closeInteraction`, `submitResponse`, `askQuestion`, `upvoteQuestion`, `markQuestionAnswered`. All verify auth + ownership/enrollment; mutations rely on migration-36 triggers to fan out broadcast events. |
| `aggregates.ts` | Pure helpers — `computePollAggregate`, `computeQuizAggregate`, `scoreQuizResponse`. Server is the authoritative computer (via the trigger); these exist for client display + tests. |
