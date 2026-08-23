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

**The extension has been run in a real Chromium and graded.** `npm run test:e2e`
loads `dist/` into Chromium, records a session on a page with five documented
defects, finds all five, and then takes the `.spec.ts` it generated and **runs
it** — in English and in Arabic RTL. `npm run test:e2e:site` does the same
against the real OrangeHRM demo. `npm run test:e2e:ai` proves the whole chain
once: real capture → real redaction → real Gemini → rendered report.

That testing found **eleven defects the offline tests could not**, including one
that silently dropped a recorded step every time a tester typed a value and
pressed Enter. Section 20 of PLAN.md lists all eleven.

An **adversarial review** afterwards — five independent reviewers, each finding
attacked by three more — found **seventeen more** — 125 agents, 40 candidates, 23 rejected on
verification — including one that threw the video away on every successful
recording. Section 22 has the full list. The
lesson worth keeping: nine redaction tests were green while a raw page URL
carrying an access token went to the API in a field none of them happened to
look at. The fix that matters is not the patch, it is the structural test that
now plants a secret in *every* string of the bundle and reports where it
survived.

**The video path works end to end, and is tested.** A real tab is recorded to
`video/mp4;codecs=vp9,opus`, survives pause and resume as one playable file,
is stored in IndexedDB, and is accepted and analysed by Gemini — inline and via
the Files API. `npm run test:e2e:video` and `npm run test:e2e:video-ai` cover it.

Getting there took a long detour that is worth knowing about, because the
conclusion was wrong for a while: capture failed with `NO_HARDWARE` and
`NotFoundError` on every display server, which looked like a hardware limit and
was written up as one. The actual cause was `--use-fake-ui-for-media-stream` in
the *test harness* — a documented incompatibility with `tabCapture`. Section 23
of PLAN.md has the full sequence, including the real bug it then exposed: the
base64 encoder split the data URL at the first comma, and a recorded MIME type
contains one (`codecs=vp9,opus`), so **inline video would have been rejected
every time in production**.

The one thing still unverified is whether an offscreen document can raise a
microphone permission prompt: this machine reports zero audio *input* devices,
so the question cannot be answered here. Narration is optional and its absence
leaves a silent video rather than cancelling the session.

**`uploadVideoToFilesApi` in [`src/ai/gemini.ts`](src/ai/gemini.ts) is still a
sketch of the flow, not verified code**, and says so inline. The live test does
not exercise it. Section 0.2 of PLAN.md is the full checklist (V1–V15) with
V1–V3 now marked confirmed and the rest still open.

Recording, capture, code generation and redaction do **not** depend on any of
that, and are covered by the test suite.

---

## The seeded defect bench

A live page with five deliberate, documented defects, for checking whether your
capture tooling finds them all — and whether it invents a sixth:

**https://claude.ai/code/artifact/372b6b69-07ae-474c-8dc8-5e5597da0d20**

The same page is in [`fixtures/bench.html`](fixtures/bench.html) and is what
`npm run test:e2e` grades against.

## Install for development

```bash
npm install
npm run verify        # typecheck + build + 120 tests
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
4. Press **Record** — or press **Ctrl+Shift+E** on the page itself, which is
   more reliable: Chrome only permits video capture after you *invoke* the
   extension on that tab, and the shortcut does exactly that. Rebind it at
   `chrome://extensions/shortcuts`.
5. Do your normal test steps, then press **Stop** (or the shortcut again).
6. The review page opens by itself with the video, the step list, the generated
   spec and the report.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Bundles everything into `dist/` |
| `npm run build:watch` | Rebuilds on change, with sourcemaps |
| `npm run typecheck` | `tsc --noEmit`, strict mode |
| `npm test` | Bundles the test API and runs the suite |
| `npm run verify` | All three, in order (never touches the network) |
| `npm run test:e2e` | 11 tests in a real Chromium, including the graded bench and the replay round-trip |
| `npm run test:e2e:site` | Against the real OrangeHRM demo application |
| `npm run test:e2e:video` | The media path: capture, pause/resume, playback |
| `npm run test:e2e:video-ai` | A real recorded video sent to Gemini |
| `npm run test:e2e:perf` | Capture overhead per click on a 600-row page |
| `npm run test:live` | Five checks against the real Gemini API. Needs a key in `.env` |
| `npm run test:e2e:ai` | The whole chain once: capture → redaction → Gemini → rendered report |
| `npm run test:all` | Everything above, in order |
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

## What gets recorded

Every direct action, in the session and in the generated script:

| You do | Recorded | The script replays it as |
|---|---|---|
| Click, double-click | ✅ | `.click()`, `.dblclick()` |
| Type | ✅ every keystroke, corrections included | `.pressSequentially()` — real key events |
| Paste, copy, cut | ✅ with the text, and where it came from | `navigator.clipboard.writeText()` then `.fill()` |
| Right-click, middle-click | ✅ | `.click({ button: … })` |
| Enter, Tab, Escape, arrows, Home/End… | ✅ | `.press()` |
| Any Ctrl / Alt / Meta shortcut | ✅ | `.press('Control+f')`, flagged if the browser owns it |
| Drag and drop | ✅ both ends | `.dragTo()` |
| Pointer movement | ✅ sampled | evidence only — it changes nothing |
| Select, check, uncheck | ✅ | `.selectOption()`, `.check()` |
| Scroll, state-changing hover | ✅ | comment / `.hover()` |

**The script replays at your pace.** Each step waits the time you actually
waited before it — `await waitLikeTheTesterDid(4500)`. A replay at machine speed
is a different test: a token that expires after ten seconds, a debounce that
settles after two, a toast that vanishes after five, none of them happen when
every step runs 40ms after the last. Gaps are capped at 15s so one interruption
does not stall the run, and `REPLAY_SPEED=0` turns the pacing off for CI
(`REPLAY_SPEED=2` runs at double speed).

**Copy is traced to paste.** The script says where a pasted value came from —
*"They copy-ed it earlier in this session, at 00:09"* — or says plainly that it
came from outside the recording. Copying is replayed by writing the text to the
clipboard, so a later paste in the same script finds it; that needs
`clipboard-write` permission, and the generated script says so.

**Expected Behavior is yours to write.** The model is required to say "not
determinable from the recording" rather than invent what should have happened.
The review page has a box next to the report where you say it, and a button that
puts it in — tagged `(stated by the tester)`, because a human assertion and a
machine inference are different kinds of claim.

**A picture of the final state goes in the report.** The moment you stop
recording is the moment the defect is on screen — it is why you stopped. It is
taken with `captureVisibleTab` when Chrome allows it, and from the last frame of
the recording when it does not, and it follows the same upload consent as the
video because an image cannot be redacted the way text can.

Typing replays key by key rather than through `fill()` on purpose: `fill()` sets
the value and fires one event, so an autocomplete that fires on the third
character or a validator that runs on keyup never happens — and a script built
from `fill()` can pass on the very defect it was recorded to demonstrate. Paste
is the opposite, and replays as `fill()`, because a paste really does arrive in
one step.

Pointer movement is sampled rather than recorded raw. A browser reports it at
the display refresh rate, which would be hundreds of thousands of entries nobody
reads. The sample keeps the shape, which is the part that means something.

## Licence and trial

**14 days from install, free.** After that the AI report needs a licence.
Recording, the video and the generated Playwright script keep working — a tester
whose trial runs out mid-session keeps everything they recorded.

The side panel names the days left every session, so nobody is cut off by
surprise.

**What this enforcement is worth, stated plainly.** It runs on the customer's
machine, in an extension whose source they can read. It is a speed bump, not a
lock: clearing storage or reloading an edited `dist/` resets it. What it does do
is keep an honest customer informed, defeat an accidental extension (a clock set
backwards is caught by a high-water mark), and put the paid state behind a key
that a server can validate the moment one exists.

**Before you sell it**, three fields in `src/shared/constants.ts`:

| Constant | What goes in it |
|---|---|
| `PAYPAL_CHECKOUT_URL` | your PayPal payment link — empty in this build, and the Buy button says so |
| `LICENCE_PRICE_DISPLAY` | the price, shown next to the button |
| `LICENCE_VERIFY_ENDPOINT` | your verify server — until it is set, key checking is local and the options page says that in those words |

The payment link is deliberately not filled in. A payment URL is an account
number, and a wrong one sends money to a stranger without anything looking
broken. PLAN.md section 24 has the server contract and the PayPal steps.

## Permissions, honestly

**The install prompt asks for no site access at all.** The extension can reach
one origin on install — the Gemini API — and nothing else. You grant the sites
you actually test, one at a time, from the options page; Chrome's own dialog
then says "Read and change your data on **staging.example.com**" rather than "on
all websites".

Here is exactly why each piece is there, and what you can cut.

| Permission | Why |
|---|---|
| `tabCapture` | The video. There is no other way. |
| `offscreen` | Hosts `MediaRecorder`; an MV3 service worker has no DOM. |
| `host_permissions: generativelanguage.googleapis.com` | The only origin granted on install. An MV3 service worker cannot `fetch` a host it does not hold. |
| `optional_host_permissions: http/https` | **Not granted on install.** Per-site, on request, from the options page. Content scripts are registered for granted origins only; `webRequest` reports nothing without a grant. |
| `scripting` | Registers the content scripts for granted origins at run time, and injects into a single tab under `activeTab` when you record on a site you have not granted. |
| `webRequest` | Status codes for requests the page's own JavaScript never reports. |
| `webNavigation` | Real navigations, and the iframe tree for `frameLocator()` chains. |
| `unlimitedStorage` | Videos are 8–70 MB per session. |
| `tabs`, `activeTab`, `storage`, `sidePanel` | Tab metadata, settings, controls. `activeTab` is also the fallback that lets you record on a site you have not granted. |

**`webRequest` is the one to cut first** if the listing needs to look less
alarming. Dropping it costs status codes for navigations and for requests the
application swallows internally. It does **not** cost response bodies — those come
from the MAIN-world `fetch` patch. A build without it still produces good
reports.

**Grant the site before you record.** The side panel warns you when the site in
front of you is not granted and offers a one-click grant, because without it the
recording is close to useless: you get the video and the page addresses, and
nothing you type or click.

**Recording on a site you have not granted still works**, with two caveats.
Press Record — use the keyboard shortcut, since `activeTab` is only granted by a
real invocation — and the extension injects into that single tab, re-injecting
after every navigation so the rest of the journey keeps recording.

What you lose:

- **Requests the page made before you pressed Record.** The `fetch` patch lands
  on invocation instead of at `document_start`.
- **Everything after you leave the site.** `activeTab` is revoked by a
  cross-origin navigation, so a journey that crosses to another domain stops
  capturing interactions there.

Granting the origin removes both. The first real session against a live site ran
this path without a grant and produced a script that was almost entirely
`page.goto()` calls — every click after the first navigation was lost, because
an injected script belongs to one document. The re-injection above is what fixed
it.

**Why there are no `content_scripts` in the manifest.** A static entry with
`<all_urls>` matches forces the broad grant even when the host permission is
optional — measured, not assumed: with the entries present a fresh profile
reports both origin patterns as already granted; with the entries deleted it
reports only the API origin. So the entries are gone and registration happens at
run time. `e2e/permissions.e2e.mjs` holds that behaviour in place.

**Nothing is requested that is not used.** `desktopCapture` was in an earlier
manifest and was removed once a review confirmed no code path called it. It comes
back when v2 implements screen recording.

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

Five layers, cheapest first. Only the first is required to work on the project.

**120 offline unit tests** (`npm test`) — no browser, no key, no network. jsdom is
a test-only dependency.

The load-bearing one is in [`tests/prune-dom.test.mjs`](tests/prune-dom.test.mjs):
given a catalog page whose tabs read *"Contract Renewal & Continuation"* and
friends, the pruned DOM must still contain **every label, verbatim, in order**.
If a change to the pruning policy breaks that test, the change is wrong —
however much smaller it makes the output.

**11 browser tests** (`npm run test:e2e`) — a real Chromium with the real
extension loaded. The two that matter:

- **The graded bench.** [`fixtures/bench.html`](fixtures/bench.html) has five
  *documented* defects, so a run can be scored rather than admired. Two of them
  are invisible on screen and exist only in the markup — the argument for
  capturing page code rather than screenshots, made concrete. The suite asserts
  all five are captured *and* that no sixth was invented.
- **The replay round-trip.** Record a session, take the `.spec.ts` the extension
  generated, and run it with Playwright. If that fails, the product's central
  promise is not true, however good the report looks.

**The real-site test** (`npm run test:e2e:site`) — OrangeHRM, a real React app
whose class names change on every build. All four locators resolved to `role` +
accessible name with zero xpath fallbacks, and the password was redacted at
capture time while the username was deliberately left alone.

**The live AI test** (`npm run test:live`) and **the full pipeline**
(`npm run test:e2e:ai`) — described above.

The suite also covers: the redaction gate failing closed on malformed input, a
`fill()` in the generated script losing a card number, a credential printed as
page text being redacted while its label survives, the selector chain never
touching a class name, list-row anchoring, the generated spec containing no
arbitrary sleeps, the validator rejecting an invented specification wearing a
not-determinable flag, video offsets staying correct across a pause, and the
serialisation that prevents concurrent handlers from overwriting each other's
recorded steps.

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
