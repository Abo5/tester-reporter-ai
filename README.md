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

**The model and the request shape are confirmed working.** `npm run test:live`
has been run against the real API and passed 5/5: `gemini-3.5-flash` exists, the
endpoint and body shape are right, and schema-constrained JSON output works. An
earlier version of this file warned that the model might not exist — that
caution was reasonable when written and is now simply wrong.

**What is still unverified is the video path and the browser path.** The live
run sent text evidence only, so nothing proves the Files API upload or which
video MIME types are accepted. And nothing in this repository has run inside
Chrome: `tabCapture`, the offscreen `MediaRecorder`, and the microphone grant
are all still theory.

**`uploadVideoToFilesApi` in [`src/ai/gemini.ts`](src/ai/gemini.ts) is still a
sketch of the flow, not verified code**, and says so inline. The live test does
not exercise it. Section 0.2 of PLAN.md is the full checklist (V1–V15) with
V1–V3 now marked confirmed and the rest still open.

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
| `npm run verify` | All three, in order (never touches the network) |
| `npm run test:live` | **The one test that calls the real Gemini API.** Needs a key in `.env` |
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

## Talking to the real Gemini API

Everything above runs offline. To check that a real model, given real evidence,
returns a report this extension can actually use:

```bash
cp .env.example .env
# put your Google AI Studio key in GEMINI_API_KEY
npm run test:live
```

`.env` is gitignored and **is never read by the extension**. Node loads it itself
via `--env-file-if-exists`; no code in this repository opens that file. The
extension running in your browser reads its key from `chrome.storage.local`,
set in its own Settings page — the two are completely separate.

Without a key the live test **skips** rather than fails, so it never blocks a
normal run.

`.env` also carries `GEMINI_MODEL`. Use it to point at a model id you have
actually verified, without editing code. If the id is not in `SUPPORTED_MODELS`
the test registers it for that run and tells you the one-line change to make it
permanent.

**This is the test that tells you whether the `VERIFY` items are right.** It
sends the tenant-search scenario — a 500, an `aria-invalid` field, and an error
message that is in the DOM but not on screen — and then checks that the model:

- returned JSON our validator accepts;
- did **not** claim it watched a video (none was sent) — the exact hallucination
  `reconcileEvidenceUsed()` exists to catch;
- grounded the report in a captured fact (`500`, `Tenant ID must be 8 digits`,
  `TN-40192`, `aria-invalid`, `tenant_not_found`) rather than inventing one;
- either derived Expected Behavior or used the required sentence byte for byte.

It prints the finished report and the anti-hallucination fields, so you can read
what the model actually said. The assertions are deliberately tolerant about
wording — asserting exact model prose would be a flaky test that teaches you
nothing.

If it fails with `http-error` 404, the model id is wrong. If it fails with
`malformed-json`, the structured-output parameter names need checking against
current documentation.

## Testing

86 offline tests, no browser and no API key required. jsdom is a test-only
dependency.

`npm test` takes around 40 seconds on a Raspberry Pi and a few seconds on a
laptop. Almost all of it is jsdom construction in `prune-dom` and `selector`,
which build a fresh DOM per test on purpose so no test can leak state into the
next one. The tests themselves account for under three seconds.

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
