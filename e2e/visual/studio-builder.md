# Studio builder: describe a tool, approve its settings, preview it, save it

**Target:** local dev (`localhost:3000`) with local Supabase. Mechanics: [README.md](./README.md).
**Build under test:** Studio Step 7B, the Step 7C builder hardening ([studio-agent-harness.md](../../docs/reference/studio-agent-harness.md)), and the Step 11 progress and preview changes ([studio-builder-quality.md](../../docs/designs/studio/studio-builder-quality.md) 3.9).
**Not yet run against Step 11:** the lines and preview states in A.1, A.3, A.4 and section H are written from the design and need a live run.
**Last run:** 2026-10-02, scripted with Playwright: sign in, sections A to D, history, undo, phone width. It ran on a production standalone build under Node 22 against a local PostgreSQL 17 with real PostgREST (not local Supabase) and the live model, with the runtime origin behind a local https proxy, because production mode requires an https runtime origin. Every check passed after the fix it found: plugin frames 404ed in production builds (see `requestHost` in `src/lib/studio/runtime/origin.ts`). The question card (a question the model chooses to ask) and the screen reader checks were not reached. Each build spends a few cents of Gemini usage.

## Setup

1. Grant the dev institution the `studio` entitlement: super admin, Institutions, the institution's Plan card.
2. `.env.local` needs `GOOGLE_GENERATIVE_AI_API_KEY`, `BACKGROUND_JOBS_SECRET`, `BACKGROUND_JOBS_KICK_URL=http://localhost:3000/api/jobs-worker/kick`, `STUDIO_RUNTIME_ORIGIN=http://127.0.0.1:3000` and `STUDIO_FRAME_TICKET_SECRET`.
3. Sign in as the professor of CS101 and open `/professor/courses/<CS101>/studio`.

## A. A first build pauses once for approval

1. Type "Build flashcards my students can flip through for this week's terms. I add the terms myself." and press **Build**. Expect the builder to open full screen with fixed progress lines ("Getting ready", "Understanding your request", "Planning the tool") and a **Stop** button. No tool names, file paths or model text appear in the lines. Once the plan is in, an "Athena's plan" card above the lines shows the goal and bullets under "Professor view" and "Student view". The preview pane shows a placeholder for each view and "Athena is building your first draft. It appears here once it passes its checks."
2. Expect "This tool would:" with lines such as `Store "cards": staff write, everyone in the section reads`, and no text written by Athena on the card. Expect "Approving lets Athena keep building this draft. It doesn't install the tool or show it to students." and a muted "Waiting for you until <time>" line. The time is in your locale, with a weekday when it isn't today. The header badge reads "Needs your approval".
3. Press **Approve**. Expect progress to continue ("Building the student view", "Adding sample data for the preview", "Checks passed", "Rendering the preview", then "Design review passed" or "Found improvements to make" and "Improving the interface"), and the spinner line to name the step in progress ("Reviewing the design…"), never one that already finished. Then "Preview ready" with Athena's note and **Preview** and **Save as version** buttons. Under the card, "What Athena did (N steps)" is closed; Tab to it and press Enter to open the full list of steps, which matches the lines shown while it worked.
4. Open the preview. Expect both views side by side on sample data, a phone toggle that narrows them, a **Reload preview** button, and "Sample data. Students don't see drafts." Nothing appears in the course sidebar for students.

## B. Stop and replace

1. Send a follow-up ("Add a shuffle button to the student view") and press **Stop** while it is working. Expect "Stopped. Your tool is unchanged." and the preview still showing the previous draft.
2. Send a request that needs approval ("Show the course name at the top of the student view"). While the card is showing, send another message. Expect "Your last request is waiting for you. Replace it with this one?" with **Replace it** and **Keep it**. **Keep it** changes nothing; **Replace it** starts the new request.
3. Reload the page while the approval card is showing. Expect the tool card to read "Needs your approval". Open it. Expect the same card back, from the server, with nothing re-asked.

## C. Save as version is separate

1. On a "Preview ready" card, press **Save as version**. Expect "Checking and saving…", then "Saved as version 1.0.0. It isn't installed or shown to students."
2. Back on the Studio tab, expect the tool listed with "Saved as v1.0.0". The course sidebar is unchanged for students.

## D. History and undo

1. With two finished builds on the tool, open **History** in the builder header. Expect one row per build, newest first, each with your request, how long ago it was made, and badges: "Current draft" on the newest, "Undo goes back here" on the one before, and "Saved as version 1.0.0" on the one saved in section C.
2. Narrow the window to phone width (375px). Expect the History panel to fit on screen with no sideways scrolling, and long requests cut to two lines.
3. Send a request and, while it works, look at **Undo last change**. Expect it dimmed. Clicking it shows "You can undo once this request finishes, or after you stop it." and changes nothing. Press **Stop**.
4. Press **Undo last change**. Expect "Go back to your previous draft?", saying you can go back one step only and can't redo it. **Keep this draft** changes nothing. **Go back** shows "Back to your previous draft.", the preview switches to the earlier draft, History moves "Current draft" down one row, and the Undo button goes away.
5. Keyboard only: Tab to **History**, press Enter, and expect focus inside the panel; Escape closes it and returns focus to the button. Tab to **Undo last change** and confirm with Enter.

## E. Phone layout and screen readers

1. At phone width, finish a build and press **Preview** on the ending card. Expect the preview pane to show and keyboard focus to land on it (the next Tab reaches the Professor, Student and Both toggles), not on the page body.
2. With VoiceOver or NVDA on, send a request that needs approval. Expect "Athena needs your approval." once, not twice. When the build ends, expect one short announcement such as "Preview ready." or "Athena couldn't finish this request." Repeat at phone width with the **Preview** pane showing: the announcements still come.

## F. Endings say what to do next

1. Press **Stop** on a working build. Expect "Stopped. Your tool is unchanged." and "Send it again, or describe something different below." with a **Try again** button that sends the same request again. Type something in the chat box first: after **Try again** it is still there.
2. Scroll up in a long conversation while a build is working. Expect the log to stay where you scrolled. Scroll back to the bottom and expect it to follow new progress again.

## G. A course assistant sees none of it

1. Sign in as a TA of CS101 and open the Studio tab. Expect the course-assistant landing, not the builder.
2. Request `/api/studio/builder/runs/<a run id from section A>`. Expect a 404.

## H. The preview follows each build

1. Open a tool that has never been built. Expect "Your tool appears here", saying the professor and student views will run there on sample data, and no **Reload preview** button.
2. On a built tool, choose **Student** and **Phone size**, then send a follow-up ("Add a shuffle button to the student view"). While it works, expect "Athena is still working. This is your draft from before this request." above the old draft.
3. When it finishes, expect an "Updated <time>" badge in the preview toolbar and a brief ring around the frame that fades within a few seconds. The preview stays on **Student** at phone size. With the OS set to reduce motion, the ring appears and goes without animating.
4. Press **Reload preview**. Expect the frame to load again on the same draft.
