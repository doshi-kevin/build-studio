// Namespaced data-testid constants (Gemini). Using `{area}:{target}` mirrors
// src/components/{admin,professor,student}/... so failure traces are readable.
// Kept centralized so the testid name never drifts from the spec that targets it.

export const TID = {
  // Auth
  authLoginForm: 'auth:login-form',
  authForgotForm: 'auth:forgot-form',
  authResetForm: 'auth:reset-form',

  // Quiz
  quizEditorSave: 'quiz:editor-save',
  quizPublishButton: 'quiz:publish-button',
  quizStartAttempt: 'quiz:start-attempt',
  quizSubmitAttempt: 'quiz:submit-attempt',
  quizResultsScore: 'quiz:results-score',
} as const
