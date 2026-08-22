# Tester-Reporter-AI

A Chromium (MV3) extension that turns one manual QA session into three artifacts:

1. **A video** of the session, with the tester's spoken narration.
2. **A runnable Playwright `.spec.ts`** that replays the same steps.
3. **A written bug report** in a fixed template, produced by a multimodal model
   that is handed the page's real code, the action script, and the video at once.

Built for manual QA testers working on bilingual (English/Arabic) web applications
on staging environments. The design goal is a bug report in under two minutes
instead of thirty.

The full architecture, the reasoning behind every trade-off, and the honest list
of limitations are in **[PLAN.md](PLAN.md)**.

---

## ⚠️ Read this before you run it

**The AI model id is unverified.** The project is configured for
`gemini-3.5-flash`, which the author could not confirm exists. It appears in
exactly one place — `SUPPORTED_MODELS` in
[`src/shared/constants.ts`](src/shared/constants.ts) — and never in business
logic. Check the official Gemini model list and change that constant before you
expect a report to come back.

**The whole Gemini request surface is marked `VERIFY` in the code.** Endpoint
paths, structured-output parameter names, the Files API upload handshake, video
MIME types and token accounting all change between releases. The `uploadVideoToFilesApi`
function in [`src/ai/gemini.ts`](src/ai/gemini.ts) carries an explicit note that it
is a sketch of the flow, not verified code. **Make one real API call by hand and
write down what comes back before trusting that file.** Section 0.2 of PLAN.md is
a 15-item verification checklist (V1–V15) covering both Gemini and the Chrome
APIs the author was less than certain about.

Recording, capture, code generation and redaction do **not** depend on any of
that, and are covered by the test suite.

---

## Install for development

```bash
npm install
npm run verify        # typecheck + build + 85 tests
```

Then in Chrome, Edge or Brave:

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select the `dist/` directory

Open the extension's **Settings** and paste a Gemini API key from Google AI
Studio. Without a key you still get the video and the Playwright script; only
the written report needs one.

## Use it

1. Open the site you want to test in a normal `http://` or `https://` tab.
2. Click the extension icon to open the side panel.
3. Tick **Record microphone narration** if you want to say what looks wrong.
   (The first time, grant the microphone from Settings — an offscreen document
   cannot raise a permission prompt itself.)
4. Press **Record**, do your normal test steps, press **Stop**.
5. The review page opens by itself with the video, the step list, the generated
   spec and the report.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Bundles everything into `dist/` |
| `npm run build:watch` | Rebuilds on change, with sourcemaps |
| `npm run typecheck` | `tsc --noEmit`, strict mode |
| `npm test` | Bundles the test API and runs the suite |
| `npm run verify` | All three, in order |
| `npm run clean` | Removes `dist/` and `dist-test/` |

## Layout

```
src/
├─ shared/      Types, constants, the message union, the two clocks
├─ background/  Service worker: session state machine, routing, listeners
├─ content/     ISOLATED-world recorder + MAIN-world fetch/console patches
├─ capture/     Selector chain, DOM pruning, element context  (pure, tested)
├─ offscreen/   The only place MediaRecorder lives
├─ storage/     IndexedDB wrapper + settings
├─ codegen/     RecordedEvent[] -> .spec.ts
├─ ai/          Redaction gate, evidence bundle, prompt, schema, Gemini client
├─ sidepanel/   Recording controls
├─ review/      Video, step list, editable report, script, evidence bundle
└─ options/     API key, model, language, privacy, redaction, storage
```

Every file has a one-line purpose in section 4 of PLAN.md.

---

## The four things worth knowing about the design

**1. The redaction gate is a gate, not a filter.**
[`redactSensitiveData()`](src/ai/redact.ts) throws, and the caller does not catch
it. There is no degraded mode where a possibly-unredacted bundle gets sent
because redaction had a bad day. It runs over all three text surfaces — the
action trace, the page code, *and* the generated script, which is the one people
forget because it contains literal `fill('…')` values.

It replaces rather than deletes: a password becomes `[REDACTED:password]`, so the
model still knows a value was entered. "The tester submitted the form with a
password" and "the tester submitted an empty form" are different bug reports.

**2. The tester never loses their recording because the AI failed.**
This is enforced by ordering, not by hope. The video Blob is in IndexedDB and the
`.spec.ts` is generated and saved *before* any network request is even
considered. Every failure path in the review page — no key, offline, rate limit,
safety block, malformed JSON, redaction failure — leaves the video and the script
on screen and usable.

**3. The three evidence types answer different questions, and the prompt says so.**
The video answers *what did the tester see go wrong, and when*. The script
answers *what exact sequence of actions led there*. The page code answers *what
is actually rendered*. The precedence rule the model is given: page code wins for
exact strings, video wins for timing and layout, and a genuine contradiction
between them goes in `unverifiedClaims` rather than being silently resolved.

**4. `unverifiedClaims` and `evidenceUsed` are the anti-hallucination channel.**
The review page shows inferred claims in an amber banner above the report and
evidence types as badges. If the model claims it watched a video that was never
sent, [`reconcileEvidenceUsed()`](src/ai/validate.ts) corrects the flag, pushes a
warning, and forces confidence to `low`.

---

## Permissions, honestly

The install prompt says **"Read and change all your data on all websites."** That
is a frightening thing to ask for, and the fear is reasonable for an extension
that also records your screen. Here is exactly why each piece is there, and what
you can cut.

| Permission | Why |
|---|---|
| `tabCapture` | The video. There is no other way. |
| `offscreen` | Hosts `MediaRecorder`; an MV3 service worker has no DOM. |
| `host_permissions: http/https` | Content scripts must run on the site under test, and `webRequest` reports nothing without it. |
| `webRequest` | Status codes for requests the page's own JavaScript never reports. |
| `webNavigation` | Real navigations, and the iframe tree for `frameLocator()` chains. |
| `unlimitedStorage` | Videos are 8–70 MB per session. |
| `tabs`, `activeTab`, `storage`, `sidePanel` | Tab metadata, settings, controls. |

**`webRequest` is the one to cut first** if the listing needs to look less
alarming. Dropping it costs status codes for navigations and for requests the
application swallows internally. It does **not** cost response bodies — those come
from the MAIN-world `fetch` patch. A build without it still produces good
reports.

**A narrower permission model is possible and is not implemented.** Declaring
`optional_host_permissions` and registering content scripts dynamically with
`chrome.scripting.registerContentScripts()` after a per-origin grant would keep
the install prompt narrow. It is more code, it makes the first run worse, and
whether a static `content_scripts` entry forces a broad prompt regardless needs
to be tested rather than assumed — that is risk **R4** in PLAN.md section 16.

**Nothing is requested that is not used.** `scripting` and `desktopCapture` were
in an earlier manifest and were removed once a review confirmed no code path
called either. `desktopCapture` comes back when v2 implements screen recording.

**`chrome.debugger` is deliberately NOT used.** It would give full response
bodies and browser-generated console messages (CSP violations, mixed content,
image 404s — all of which this extension currently misses). It also shows a
persistent "is debugging this browser" banner and blocks DevTools from
attaching. That is a v2 opt-in, not a v1 default.

## Privacy

Nothing leaves the machine except one HTTPS request to Google, and only when you
ask for a report. There is no backend, no telemetry, no analytics.

**The video cannot be redacted.** Nothing in this extension can remove a customer
name or an on-screen ID number from a recording of your screen. The review page
requires an explicit one-time confirmation before the first upload, offers
"Generate report without video" on every session, and Settings has a global
**Never upload video** switch.

The API key is stored in `chrome.storage.local`, **unencrypted**. Anyone with
access to this browser profile can read it. That is acceptable because it is the
tester's own key on their own machine; if your policy says otherwise, the answer
is a proxy backend holding a server-side key, which is the one requirement that
would justify reversing the no-backend decision.

## Known limitations

These are certain, not risks. The longer list with reasoning is section 16.2 of
PLAN.md.

- **Closed shadow roots are opaque.** The spec targets the host and says so.
- **CSS-only `:hover` effects are not recorded** — no DOM mutation to observe.
- **Virtualised lists lose off-screen rows** from page snapshots.
- **Browser-generated console messages are invisible** — CSP, mixed content,
  image 404s, CORS refusals. Only `chrome.debugger` would see them.
- **`FormData` and file-upload bodies are not captured** — reading them would
  break the application's own request.
- **Text-based locators are language-specific.** A spec recorded in English will
  not run against the Arabic build; the generated code says so in a comment.
- **PII that looks like ordinary text is not redacted** — names, addresses,
  free-text notes. Emails are.
- **One primary defect per report, by design.** A session that found four
  unrelated bugs produces one report plus a `secondaryIssues` list.
- **Expected Behavior will often be "not determinable."** The approved design is
  not in the evidence, and a design-spec database is explicitly out of scope.
  The extension does the transcription and leaves the judgement — inventing a
  specification would be worse than admitting the gap.

## Testing

85 tests, no browser required. jsdom is a test-only dependency.

The load-bearing one is in [`tests/prune-dom.test.mjs`](tests/prune-dom.test.mjs):
given a catalog page whose tabs read *"Contract Renewal & Continuation"* and
friends, the pruned DOM must still contain **every label, verbatim, in order**.
The model can only write the target bug report if that survives. If a change to
the pruning policy breaks that test, the change is wrong — however much smaller
it makes the output.

The suite also covers: the redaction gate failing closed on malformed input, a
`fill()` in the generated script losing a card number, the selector chain never
touching a class name, list-row anchoring (`filter({ hasText: 'TN-40192' })`),
the generated spec containing no arbitrary sleeps, the validator rejecting an
invented specification wearing a not-determinable flag, and video offsets staying
correct across a pause.

## Not in scope for v1

No Jira/Azure DevOps integration. No Firefox. No accounts, team collaboration or
cloud sync. No self-healing selectors. No fine-tuning or RAG over a design-spec
database.
