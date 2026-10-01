# Visual tests

These are browser walkthroughs, one markdown file per feature. Claude runs them live against
`localhost:3000` using the Chrome DevTools MCP server and records what happened.

They exist because the Playwright suite in `e2e/tests/` cannot check everything. Playwright
asserts on things you can express in code, and it runs in CI. These check what a person actually
sees: whether the page looks right, whether the AI output is any good, whether a multi-step flow
feels broken. That is hard to write as an assertion.

## How the files work

Name each file after the feature it covers (`ccat-adaptive-quiz.md`, not `test-procedure.md`).

Each file is two things at once: the steps to run, and the log of the last run. When you run one,
update it with what you exercised, what you confirmed, and any bugs you found or fixed.

Videos and screenshots are throwaway. `*.webm` and `*.png` are gitignored. Record them, attach
them to the pull request or Slack, then delete them locally. The markdown log is the thing we keep.

Feature files say *what* to test. The mechanics below say *how* to drive the browser. Do not
repeat the mechanics in each feature file.

## Setup

**Browser.** Chrome DevTools MCP is configured in `.mcp.json` as `chrome-devtools`, launched with
`--experimentalScreencast`. Playwright stays registered as a fallback. The tools are deferred, so
load them with `ToolSearch` (`select:mcp__chrome-devtools__navigate_page,…`).

This is a separate browser window and it does not share your cookies. It does reuse a persistent
profile at `~/.cache/chrome-devtools-mcp/chrome-profile`, so it is often still logged in from a
previous run. Take a snapshot before assuming you need to log in.

**Local stack.** Run `npm run dev` with local Supabase, then seed it with
`bash scripts/dev-setup/setup-local.sh`. That gives you professor@scholera.dev and
student1 through student6@scholera.dev (password is in `.env.local`) plus courses CS101 and CS201.
A `supabase db reset` wipes uploads and users, so re-seed after one. AI features need
`GOOGLE_GENERATIVE_AI_API_KEY` in `.env.local`; copy it from `.env.test`.

**Stale dev server.** Next's hot reload sometimes keeps serving an old chunk after you edit a
server action or a lib file. If a change is not taking effect, do not trust hot reload. Kill
`next dev`, `rm -rf .next/dev/lock`, and start it again.

## Driving the browser

Navigate or click, then call `take_snapshot` to get fresh `uid`s. Uids change on every snapshot
and stop working after navigation, so never write one into a feature file. Record stable
selectors instead: a role plus the accessible name.

Some clicks quietly do nothing, Radix components especially. When a click does not change the
state, try `evaluate_script` with `(el) => el.click()`.

A few components need specific handling:

- **Radix checkbox rows** (`button[role=checkbox]` inside a `<label>`): a scripted `.click()`
  does not toggle React state. Use a real click on the row, and check the "N selected" counter
  before you move on.
- **NumericInput fields**: `fill` appends to what is already there, and setting `.value` directly
  gets reset on blur. Click the field, press Ctrl+A, then type.
- **File uploads**: call `upload_file` on the dropzone element. Absolute paths work, because this
  is real Chrome and not sandboxed to the repo.

When you need to wait for something, poll the database read-only rather than reloading the page.
Reload loops make the URL jitter and the run harder to follow.

## Recording

Screencasting (`screencast_start` and `screencast_stop`) works but is fragile:

- Navigate to the first real page *before* you start recording, or the first frame is blank.
- Exactly one `chrome-devtools-mcp` process may be running. If the server respawns mid-run the
  recording is lost. Check with `pgrep -af chrome-devtools-mcp`; two sets of processes means kill
  them all and let one come back.
- Never kill the MCP while recording. You get a 0-byte WebM. Only a clean `screencast_stop`
  flushes ffmpeg. Afterwards, fix the timeline with
  `ffmpeg -i in.webm -c copy -fflags +genpts out.webm`.

If the setup keeps crashing, the fallback works reliably: take numbered `take_screenshot` frames
at each important moment into `tmp/…-frames/`, then build a slideshow with
`ffmpeg -f concat -i list.txt -vf "scale=…,pad=…" -c:v libvpx-vp9 out.webm`.

Either way, check the file before you trust it. Run `ffprobe` to confirm it has real frames, pull
a frame from the middle out to PNG, and look at it.

## Cleanup

Delete temporary fixture copies and any stray screenshot PNGs. Videos and frames are gitignored;
delete them once the pull request description is written.

The local seed data is safe to write to. Keep or delete the quizzes and modules you created as
makes sense, and note anything you left behind in the run log.
