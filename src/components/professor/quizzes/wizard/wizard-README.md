# Quiz Studio Folder

Single-screen quiz creation/editing studio (docs/designs/quizzes/quiz-editor-studio.md):
question rail · focused canvas · settings drawer · student preview. AI is not a
mode here — Athena sits in the header (docs/designs/quizzes/athena-quiz-authoring.md)
and writes/edits questions through the same state the professor's own hands use.
(Folder keeps its historical `wizard/` name.)

| File | Purpose |
|------|---------|
| `QuizStudio.tsx` | Main container — studio layout, form state, autosave, save/publish actions |
| `QuizStudioRail.tsx` | Left rail: question thumbnails (drag anywhere to reorder), split button, add-hub button |
| `AddQuestionSplitButton.tsx` | Shared split button: one-click sticky-type add + full question-type menu (rail + hub) |
| `AddQuestionHub.tsx` | Center-canvas hub: split button + bank / JSON cards (landing + re-opened mid-quiz) |
| `QuizSettingsDrawer.tsx` | Right sheet with all quiz-wide settings (wraps `QuizInfoStep`) |
| `QuizInfoStep.tsx` | Quiz-wide settings form sections (rendered inside the drawer) |
| `QuizReviewStep.tsx` | Preview toggle body: settings/stats summary, then every question through the student player's `QuestionDisplay` (walkthroughs: inert `WalkthroughChat`) — answerable locally, no answer key, nothing persisted |
| `QuestionEditorCard.tsx` | Editor for the selected question's content — type pill, GitHub-style text frame with attach strip (drop/paste/browse/library), answers |
| `QuizStudioQuestionSidebar.tsx` | Right sidebar: the selected question's own settings — difficulty, points, Bloom's, tags, explanation, bonus/extra-credit, delete |
| `QuestionSourceChip.tsx` | "Source · p.N" chip on AI questions — opens the source page in a right-hand preview panel |
| `PickFromBankDialog.tsx` | Sheet for selecting existing questions from the question bank |
| `UploadJSONDialog.tsx` | Paste/upload JSON import of questions |
