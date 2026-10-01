import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      // React Hooks v7 compiler rules — downgraded to warn for pre-existing patterns
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
  // AI kill-switch tripwire (works with src/__tests__/ai-call-site-coverage.test.ts):
  // new files may not import the Gemini SDK directly — AI calls must live in a
  // module gated by src/lib/ai/kill-switch.ts and allowlisted in that test.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/__tests__/**",
      // The guarded modules (see ai-call-site-coverage.test.ts for each guard's location).
      "src/app/api/chat/route.ts",
      "src/app/api/professor-assistant/route.ts",
      "src/app/api/assignment-assistant/route.ts",
      "src/app/(dashboard)/professor/courses/\\[sectionId\\]/assignments/actions.ts",
      "src/app/(dashboard)/student/courses/\\[sectionId\\]/ai-tutor/actions.ts",
      "src/lib/ai/**",
      "src/lib/assignments/ai-grading/**",
      "src/lib/assignments/rubric-ai.ts",
      "src/lib/document-parser/vision.ts",
      "src/lib/jobs/pipelines/outcome-alignment/**",
      "src/lib/quiz/irt/grader.ts",
      "src/lib/pinecone/embed.ts",
      "src/lib/pinecone/decompose.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // @ai-sdk/react is exempt: client-side chat UI, no server spend.
              group: ["@ai-sdk/*", "!@ai-sdk/react", "groq-sdk"],
              message:
                "AI calls must go through a module gated by the AI kill switch (src/lib/ai/kill-switch.ts). Put the model call in a guarded lib and allowlist it in ai-call-site-coverage.test.ts.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Non-Scholera directories
    "SkillSignal-AI-/**",
    "scripts/**",
    "supabase/**",
    // Local-only experiments (gitignored)
    "tmp/**",
    // Local-only Claude tooling (gitignored skills/agents — not app source)
    ".claude/**",
    // Job descriptions + take-home assignment packets (gitignored working tree,
    // and the packets contain deliberately incomplete sample apps — not app source)
    "docs/jobs/**",
  ]),
]);

export default eslintConfig;
