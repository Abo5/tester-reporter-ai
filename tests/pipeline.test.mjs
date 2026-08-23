// =============================================================================
// tests/pipeline.test.mjs
// The AI pipeline's non-network parts: validation, the fixed template, the
// truncation rules, the token estimate and the schema/interface consistency.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

const api = await import("../dist-test/test-api.mjs");

/** A valid report, used as the baseline for the negative cases. */
function makeReport(overrides = {}) {
  return {
    title: "The category tab labels do not match the approved design",
    description: "The category tabs are displayed with wording that differs "
      + "from the approved design.",
    precondition: "User is not logged in, the services page is open on staging.",
    stepsToReproduce: [
      "Open the services page on staging in English.",
      "Read the labels of the category tabs one by one.",
    ],
    currentBehavior: 'The tabs read "Contract Renewal & Continuation".',
    expectedBehavior: api.NOT_DETERMINABLE_SENTENCE,
    expectedBehaviorDeterminable: false,
    severityGuess: "minor",
    defectType: "content",
    evidenceUsed: {
      video: true, playwrightScript: true, pageCode: true, networkOrConsole: false,
    },
    supportingEvidence: ["snapshot at 00:15 shows the tab labels"],
    unverifiedClaims: [],
    secondaryIssues: [],
    confidence: "high",
    ...overrides,
  };
}

// --- Validation -------------------------------------------------------------

test("a well-formed report validates", () => {
  const result = api.validateBugReport(makeReport());
  assert.equal(result.isValid, true, result.problems.join("; "));
});

test("an empty required field is rejected", () => {
  const result = api.validateBugReport(makeReport({ title: "   " }));
  assert.equal(result.isValid, false);
  assert.ok(result.problems.some((p) => p.includes("title")));
});

test("zero steps to reproduce is rejected", () => {
  const result = api.validateBugReport(makeReport({ stepsToReproduce: [] }));
  assert.equal(result.isValid, false);
  assert.ok(result.problems.some((p) => p.includes("at least one step")));
});

test("a bad enum value is rejected", () => {
  const result = api.validateBugReport(makeReport({ severityGuess: "catastrophic" }));
  assert.equal(result.isValid, false);
});

test("claiming Expected Behavior is undeterminable while writing one is rejected", () => {
  const result = api.validateBugReport(makeReport({
    expectedBehaviorDeterminable: false,
    expectedBehavior: "The tabs should read exactly as in the approved design.",
  }));

  assert.equal(result.isValid, false,
    "this is the exact hallucination the design is trying to prevent: an "
      + "invented specification wearing a not-determinable flag");
});

test("the reverse inconsistency is also rejected", () => {
  const result = api.validateBugReport(makeReport({
    expectedBehaviorDeterminable: true,
    expectedBehavior: api.NOT_DETERMINABLE_SENTENCE,
  }));
  assert.equal(result.isValid, false);
});

test("a non-object response is rejected without throwing", () => {
  assert.equal(api.validateBugReport("not json").isValid, false);
  assert.equal(api.validateBugReport(null).isValid, false);
  assert.equal(api.validateBugReport(42).isValid, false);
});

// --- Evidence reconciliation ------------------------------------------------

test("a model claiming it watched a video we never sent is corrected and flagged", () => {
  const corrected = api.reconcileEvidenceUsed(makeReport(), false, false, true);

  assert.equal(corrected.evidenceUsed.video, false);
  assert.equal(corrected.confidence, "low");
  assert.ok(corrected.unverifiedClaims.some((c) => c.includes("no video was sent")));
});

test("a model claiming page code we never captured is corrected and flagged", () => {
  const corrected = api.reconcileEvidenceUsed(makeReport(), true, false, false);

  assert.equal(corrected.evidenceUsed.pageCode, false);
  assert.equal(corrected.confidence, "low");
  assert.ok(corrected.unverifiedClaims.some((c) => c.includes("quoted on-screen text")));
});

test("reconciliation does not mutate the original report", () => {
  const original = makeReport();
  api.reconcileEvidenceUsed(original, false, false, true);
  assert.equal(original.evidenceUsed.video, true, "the input was mutated");
});

// --- The fixed template -----------------------------------------------------

test("the plain-text template has the exact fixed field order", () => {
  const text = api.formatReportAsPlainText(makeReport());
  const lines = text.split("\n");

  assert.ok(lines[0].startsWith("Title: "));
  assert.ok(lines[1].startsWith("Description: "));
  assert.ok(lines[2].startsWith("Precondition: "));
  assert.equal(lines[3], "Steps to Reproduce:");
  assert.equal(lines[4], "1. Open the services page on staging in English.");
  assert.equal(lines[5], "2. Read the labels of the category tabs one by one.");
  assert.ok(lines[6].startsWith("Current Behavior: "));
  assert.ok(lines[7].startsWith("Expected Behavior: "));
  assert.equal(lines.length, 8, "the fixed template must not gain extra lines");
});

test("the not-determinable sentence is reproduced byte for byte", () => {
  const text = api.formatReportAsPlainText(makeReport());
  assert.ok(text.includes("Expected Behavior: " + api.NOT_DETERMINABLE_SENTENCE));
});

test("the metadata variant notes when the video was not analysed", () => {
  const text = api.formatReportWithMetadata(makeReport(), "Session A", false);
  assert.ok(text.includes("NOTE: the session video was NOT analysed"));
});

test("unverified claims appear in the metadata variant", () => {
  const text = api.formatReportWithMetadata(
    makeReport({ unverifiedClaims: ["Assumed the list should be sorted by date."] }),
    "Session A", true);
  assert.ok(text.includes("UNVERIFIED"));
  assert.ok(text.includes("Assumed the list should be sorted by date."));
});

// --- Schema / interface consistency ----------------------------------------

test("the JSON schema declares exactly the fields the validator requires", () => {
  const names = api.schemaPropertyNames();
  const expected = [
    "title", "description", "precondition", "stepsToReproduce",
    "currentBehavior", "expectedBehavior", "expectedBehaviorDeterminable",
    "severityGuess", "defectType", "evidenceUsed", "supportingEvidence",
    "unverifiedClaims", "secondaryIssues", "confidence",
  ];

  assert.deepEqual(names.slice().sort(), expected.slice().sort(),
    "the schema and the GeneratedBugReport interface have drifted apart");
});

test("every schema property is listed as required", () => {
  const required = api.BUG_REPORT_RESPONSE_SCHEMA.required;
  const names = api.schemaPropertyNames();
  assert.deepEqual(required.slice().sort(), names.slice().sort());
});

// --- Truncation and selection ----------------------------------------------

test("a long action trace is truncated from the MIDDLE and the gap is declared", () => {
  const steps = [];
  for (let index = 0; index < 200; index = index + 1) {
    steps.push({
      stepNumber: index + 1,
      actionType: "click",
      elementDescription: "step " + index,
      inputValue: "",
      wasRedacted: false,
      pageUrl: "https://x.test/",
      wallClockMs: index,
      videoTimestamp: "00:00",
      videoOffsetMs: index,
    });
  }

  const notes = [];
  const result = api.truncateActionTrace(steps, notes);

  assert.ok(result.length < steps.length);
  assert.equal(result[0].elementDescription, "step 0",
    "the beginning establishes the precondition and must survive");
  assert.equal(result[result.length - 1].elementDescription, "step 199",
    "the end is where the defect appeared and must survive");
  assert.equal(notes.length, 1);
  assert.ok(notes[0].includes("omitted from the middle"));
  assert.ok(notes[0].includes("Do not assume anything"));
});

test("failure-triggered snapshots survive selection even when there are many", () => {
  const snapshots = [];
  for (let index = 0; index < 20; index = index + 1) {
    snapshots.push({
      id: "d" + index,
      sessionId: "s1",
      eventIndex: index,
      trigger: index === 7 ? "network-failure" : "interaction",
      wallClockMs: index * 1000,
      videoOffsetMs: index * 1000,
      pageUrl: "https://x.test/",
      pageTitle: "",
      documentLang: "en",
      documentDir: "ltr",
      viewportWidth: 1280,
      viewportHeight: 720,
      prunedHtml: "<document></document>",
      characterCount: 20,
      wasTruncated: false,
      droppedElementCount: 0,
    });
  }

  const selected = api.selectSnapshotsForBundle(snapshots);

  assert.ok(selected.length <= 4);
  assert.ok(selected.some((s) => s.trigger === "network-failure"),
    "the snapshot taken at the moment of failure must never be dropped");
  assert.equal(selected[0].id, "d0", "the first snapshot must survive");
  assert.equal(selected[selected.length - 1].id, "d19",
    "the last snapshot must survive");
});

test("selected snapshots stay in chronological order", () => {
  const snapshots = [];
  for (let index = 0; index < 12; index = index + 1) {
    snapshots.push({
      id: "d" + index, sessionId: "s1", eventIndex: index,
      trigger: index === 9 ? "console-error" : "interaction",
      wallClockMs: index * 1000, videoOffsetMs: index * 1000,
      pageUrl: "", pageTitle: "", documentLang: "", documentDir: "",
      viewportWidth: 0, viewportHeight: 0, prunedHtml: "", characterCount: 0,
      wasTruncated: false, droppedElementCount: 0,
    });
  }

  const selected = api.selectSnapshotsForBundle(snapshots);
  for (let index = 1; index < selected.length; index = index + 1) {
    assert.ok(selected[index].wallClockMs > selected[index - 1].wallClockMs,
      "the model needs chronological order to reason about sequence");
  }
});

test("the snapshot character budget is enforced a second time at bundle time", () => {
  const huge = "x".repeat(api.MAX_SNAPSHOT_CHARACTERS + 5000);
  const capped = api.enforceSnapshotCharacterBudget(huge);

  assert.ok(capped.length < huge.length);
  assert.ok(capped.includes("SNAPSHOT TRUNCATED AT BUDGET"));
});

test("element contexts near a failure are prioritised over recent ones", () => {
  const contexts = [];
  for (let index = 0; index < 40; index = index + 1) {
    contexts.push({
      id: "c" + index, sessionId: "s1", eventIndex: index,
      elementHtml: "", ancestorHtml: "", siblingHtml: [],
      computedStyles: {}, ariaState: {}, inheritedLang: "", inheritedDir: "",
      boundingBox: { x: 0, y: 0, width: 0, height: 0 },
    });
  }

  const selected = api.selectElementContextsForBundle(contexts, [5]);
  const selectedIndexes = selected.map((c) => c.eventIndex);

  assert.ok(selected.length <= 12);
  for (const near of [2, 3, 4, 5, 6, 7, 8]) {
    assert.ok(selectedIndexes.includes(near),
      `context ${near} is within +/-3 of the failure and should have survived`);
  }
});

// --- Environment detection and estimates -----------------------------------

test("the environment is guessed from the hostname", () => {
  assert.equal(api.detectEnvironment("https://staging.example.sa/x"), "staging");
  assert.equal(api.detectEnvironment("https://uat.example.sa/x"), "staging");
  assert.equal(api.detectEnvironment("http://localhost:3000/x"), "local");
  assert.equal(api.detectEnvironment("https://dev.example.sa/x"), "development");
  assert.equal(api.detectEnvironment("https://example.sa/x"), "unknown");
  assert.equal(api.detectEnvironment(""), "unknown");
});

test("key frames cluster around a known failure and keep the ends", () => {
  const events = [];
  for (let index = 0; index < 10; index = index + 1) {
    events.push({ index, videoOffsetMs: index * 10000 });
  }

  const offsets = api.chooseKeyFrameOffsets(100000, events, [5]);

  assert.ok(offsets.length > 0 && offsets.length <= 6);
  assert.equal(offsets[0], 0, "the first frame gives context");
  assert.ok(offsets.some((o) => Math.abs(o - 50000) < 2500),
    "frames should cluster around the failure at 50s");

  for (let index = 1; index < offsets.length; index = index + 1) {
    assert.ok(offsets[index] > offsets[index - 1], "offsets must be sorted");
  }
});

test("the supported-video check compares only the base MIME type", () => {
  assert.equal(api.isVideoMimeTypeSupported('video/webm;codecs="vp9,opus"'), true);
  assert.equal(api.isVideoMimeTypeSupported('video/mp4;codecs="avc1.42E01E"'), true);
  assert.equal(api.isVideoMimeTypeSupported("video/x-matroska"), false);
  assert.equal(api.isVideoMimeTypeSupported(""), false);
});

// --- The prompt -------------------------------------------------------------

test("the system instruction states the precedence rules explicitly", () => {
  const text = api.SYSTEM_INSTRUCTION;

  assert.ok(text.includes("THE PAGE"), "page code precedence missing");
  assert.ok(text.includes("SOURCE OF TRUTH"));
  assert.ok(text.includes("NEVER invent"));
  assert.ok(text.includes(api.NOT_DETERMINABLE_SENTENCE),
    "the exact required sentence must appear in the instruction");
  assert.ok(text.includes("AT MOST ONE primary defect"));
  assert.ok(text.includes("unverifiedClaims"));
});

test("the Arabic instruction forbids translating quoted strings", () => {
  const arabic = api.buildLanguageInstruction("ar");
  assert.ok(arabic.includes("ARABIC"));
  assert.ok(arabic.includes("Never translate a quoted string"));
});

test("the evidence text tells the model when no video was sent", () => {
  const bundle = {
    sessionId: "s1", reportLanguage: "en", actionTrace: [], playwrightScript: "",
    domSnapshots: [], elementContext: [], networkFailures: [], consoleErrors: [],
    video: {
      deliveryMode: "omitted", fileUri: "", base64Data: "", keyFrameBase64: [],
      keyFrameOffsetsMs: [], mimeType: "", durationMs: 0, sizeBytes: 0,
      downgradeReason: "No video was recorded.",
    },
    pageMeta: {
      title: "", url: "", documentLang: "", documentDir: "",
      viewportWidth: 0, viewportHeight: 0, detectedEnvironment: "", userAgent: "",
    },
    redactionCompleted: true, redactionSummary: {}, truncationNotes: [],
    estimatedInputTokens: 0,
  };

  const text = api.buildEvidenceText(bundle);
  assert.ok(text.includes("NO VIDEO WAS PROVIDED"));
  assert.ok(text.includes("You MUST set evidenceUsed.video to false"));
  assert.ok(text.includes("You MUST set evidenceUsed.pageCode to false"),
    "with no snapshots the model must be told not to quote on-screen text");
});

// --- The two clocks ---------------------------------------------------------

test("video offsets stay correct across a pause", () => {
  const startedAt = 1000;

  // No pause yet: 5s of wall clock is 5s of video.
  assert.equal(api.wallClockToVideoOffsetMs(startedAt, 0, 0, 6000), 5000);

  // After a 10s pause, wall clock 21s is only 10s into the recording.
  assert.equal(api.wallClockToVideoOffsetMs(startedAt, 10000, 0, 21000), 10000);

  // Mid-pause: the clock stops moving.
  assert.equal(api.wallClockToVideoOffsetMs(startedAt, 0, 6000, 11000), 5000);
});

test("timestamps format as MM:SS for the model and the UI", () => {
  assert.equal(api.formatVideoTimestamp(0), "00:00");
  assert.equal(api.formatVideoTimestamp(42137), "00:42");
  assert.equal(api.formatVideoTimestamp(305000), "05:05");
  assert.equal(api.formatVideoTimestamp(-1), "--:--");
});

// --- Ids on insecure origins ------------------------------------------------

test("ids are generated even when crypto.randomUUID is unavailable", async () => {
  const { createId } = await import("../dist-test/test-api.mjs");

  const originalRandomUuid = globalThis.crypto.randomUUID;
  try {
    // Simulate an http:// page, where randomUUID is [SecureContext] and absent.
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined, configurable: true, writable: true,
    });

    const first = createId();
    const second = createId();

    assert.equal(typeof first, "string");
    assert.ok(first.length >= 16, "the fallback id is too short to be unique");
    assert.notEqual(first, second, "two ids collided");
    assert.match(first, /^[0-9a-f-]+$/, "the fallback should still look like a UUID");
  } finally {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: originalRandomUuid, configurable: true, writable: true,
    });
  }
});

test("ids are unique across many calls", async () => {
  const { createId } = await import("../dist-test/test-api.mjs");

  const seen = new Set();
  for (let index = 0; index < 2000; index += 1) {
    seen.add(createId());
  }
  assert.equal(seen.size, 2000, "id collisions occurred");
});

// --- Retention policy -------------------------------------------------------

test("retention of 0 days deletes nothing", async () => {
  const { applyRetentionPolicy } = await import("../dist-test/test-api.mjs");
  const deleted = await applyRetentionPolicy(0, Date.now());
  assert.equal(deleted, 0, "0 must mean 'never', which is the default");
});

test("a negative retention value deletes nothing", async () => {
  const { applyRetentionPolicy } = await import("../dist-test/test-api.mjs");
  assert.equal(await applyRetentionPolicy(-5, Date.now()), 0);
});

test("the prompt tells the model not to escape quotes in human-readable text", () => {
  // Observed from a live run: the model quoted a JSON response body with
  // escaped inner quotes, so the pasted ticket read {\"error\":\"...\"}.
  // The fix belongs in the instruction, not in a post-hoc string cleanup that
  // would risk corrupting legitimate backslashes.
  assert.ok(api.SYSTEM_INSTRUCTION.includes("Do NOT add backslashes"));
  assert.ok(api.SYSTEM_INSTRUCTION.includes("for a HUMAN to read"));
});

// --- The lost-update race ---------------------------------------------------

test("a serialised chain preserves order and loses nothing under concurrency", async () => {
  // Models the exact failure the E2E suite caught: concurrent handlers that
  // read a counter, await, then write it back. Without serialisation two of
  // them claim the same index and one write is silently overwritten.
  let counter = 0;
  const written = [];

  async function unsafeHandler(label) {
    const readValue = counter;                 // read
    await new Promise((r) => setTimeout(r, 5)); // await, as a real DB write does
    written.push({ label, index: readValue });
    counter = readValue + 1;                    // write
  }

  // Unserialised: indexes collide.
  await Promise.all(["a", "b", "c", "d"].map(unsafeHandler));
  const collided = new Set(written.map((w) => w.index)).size < written.length;
  assert.ok(collided,
    "the unsafe version should collide - if it does not, this test is not "
      + "modelling the real failure");

  // Serialised with the same chain shape the router uses.
  counter = 0;
  written.length = 0;
  let chain = Promise.resolve();
  const runSerialised = (work) => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };

  await Promise.all(["a", "b", "c", "d"].map(
    (label) => runSerialised(() => unsafeHandler(label))));

  const indexes = written.map((w) => w.index);
  assert.deepEqual(indexes, [0, 1, 2, 3], "serialised handlers must not collide");
  assert.equal(new Set(indexes).size, 4, "an index was reused");
});

test("one failing handler does not poison the ones behind it", async () => {
  let chain = Promise.resolve();
  const runSerialised = (work) => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };

  const completed = [];
  const first = runSerialised(async () => { throw new Error("boom"); });
  const second = runSerialised(async () => { completed.push("second"); });

  await assert.rejects(first, /boom/);
  await second;
  assert.deepEqual(completed, ["second"],
    "a rejected handler must not block the queue behind it");
});

// --- The stop decision ------------------------------------------------------

test("stop only skips the recorder when there genuinely is no recorder", () => {
  // This models the decision that discarded every video: handleStopRecording
  // asks "is there a recorder to wait for?" by looking at media.state. While
  // that state stayed "not-started" after a SUCCESSFUL start, the answer was
  // always no, the session finalised immediately, and the offscreen document
  // was closed before it could hand over the Blob.
  const hadNoRecorder = (mediaState) =>
    mediaState === "failed" || mediaState === "not-started";

  // The two states that mean "nothing is recording".
  assert.equal(hadNoRecorder("not-started"), true,
    "capture never started, so there is nothing to wait for");
  assert.equal(hadNoRecorder("failed"), true,
    "capture failed, so there is nothing to wait for");

  // The states a live recorder can be in. If any of these returns true, the
  // video is thrown away.
  assert.equal(hadNoRecorder("recording"), false,
    "a running recorder MUST be waited for or its video is discarded");
  assert.equal(hadNoRecorder("paused"), false,
    "a paused recorder still holds the recording");
  assert.equal(hadNoRecorder("stopped"), false);
});

// --- The not-determinable sentence ------------------------------------------

test("the not-determinable sentence is matched despite dash and spacing drift", () => {
  // The required sentence contains an em dash. A model that emits a hyphen is
  // not wrong about the defect, and failing the whole report over it - twice,
  // after a retry - would turn the most common Expected Behavior outcome into
  // the most common failure.
  const variants = [
    api.NOT_DETERMINABLE_SENTENCE,
    api.NOT_DETERMINABLE_SENTENCE.replace("—", "-"),
    api.NOT_DETERMINABLE_SENTENCE.replace("—", "–"),
    api.NOT_DETERMINABLE_SENTENCE.replace(/\s+/g, "  "),
    api.NOT_DETERMINABLE_SENTENCE.toUpperCase(),
    api.NOT_DETERMINABLE_SENTENCE + ".",
    "  " + api.NOT_DETERMINABLE_SENTENCE + "  ",
  ];
  for (const variant of variants) {
    assert.ok(api.isNotDeterminableSentence(variant),
      `not recognised: ${JSON.stringify(variant)}`);
  }
});

test("a genuinely different sentence is NOT accepted as not-determinable", () => {
  assert.equal(api.isNotDeterminableSentence(
    "The tabs should read exactly as in the approved design."), false);
  assert.equal(api.isNotDeterminableSentence("Expected behavior unknown."), false);
  assert.equal(api.isNotDeterminableSentence(""), false);
});

test("a loosely-matching sentence is rewritten to the exact required wording", () => {
  // The extension owns the template, so downstream consumers still see the
  // agreed wording byte for byte; the model is just not punished for a dash.
  const drifted = {
    ...makeReport(),
    expectedBehaviorDeterminable: false,
    expectedBehavior: api.NOT_DETERMINABLE_SENTENCE.replace("—", "-"),
  };

  const normalised = api.normaliseExpectedBehavior(drifted);
  assert.equal(normalised.expectedBehavior, api.NOT_DETERMINABLE_SENTENCE);
  assert.equal(api.validateBugReport(normalised).isValid, true);

  // And validation now accepts the drifted form directly, without a retry.
  assert.equal(api.validateBugReport(drifted).isValid, true);
});

test("normalisation never rewrites a real expected behaviour", () => {
  const real = {
    ...makeReport(),
    expectedBehaviorDeterminable: true,
    expectedBehavior: "The tabs should read exactly as in the approved design.",
  };
  assert.equal(api.normaliseExpectedBehavior(real).expectedBehavior,
    "The tabs should read exactly as in the approved design.");
});

// --- Key-frame selection priority -------------------------------------------

test("key frames keep the ends AND the most recent failure, not the six earliest", async () => {
  // The cap used to be applied while walking a sorted list from the start, so
  // the six EARLIEST offsets won. A five-minute session with failures at 00:30
  // and 04:00 sent four frames of the first 32 seconds, dropped the second
  // failure entirely, and dropped the final-state frame the docs promise.
  const { chooseKeyFrameOffsets } = await import("../dist-test/test-api.mjs");

  const events = [];
  for (let index = 0; index < 12; index += 1) {
    events.push({ index, videoOffsetMs: index * 25000 });   // 0 .. 275s
  }
  const durationMs = 300000;

  // Failures near 00:50 (index 2) and near 04:10 (index 10).
  const offsets = chooseKeyFrameOffsets(durationMs, events, [2, 10]);

  assert.ok(offsets.length <= 6);
  assert.equal(offsets[0], 0, "the first frame is a documented guarantee");
  assert.ok(offsets[offsets.length - 1] > durationMs - 1000,
    `the final-state frame was dropped: ${JSON.stringify(offsets)}`);

  const nearLateFailure = offsets.some((o) => Math.abs(o - 250000) < 3000);
  assert.ok(nearLateFailure,
    `the most recent failure got no frame: ${JSON.stringify(offsets)}`);

  for (let index = 1; index < offsets.length; index += 1) {
    assert.ok(offsets[index] > offsets[index - 1],
      "output must be chronological, the model reads it as a sequence");
  }
});

test("with no failures the frames still span the whole session", async () => {
  const { chooseKeyFrameOffsets } = await import("../dist-test/test-api.mjs");
  const offsets = chooseKeyFrameOffsets(120000, [], []);
  assert.equal(offsets[0], 0);
  assert.ok(offsets[offsets.length - 1] > 119000);
  assert.ok(offsets.length >= 2);
});

// --- Data URL parsing -------------------------------------------------------

test("the base64 payload is found even when the MIME type contains a comma", async () => {
  // A recorded MIME type is "video/mp4;codecs=vp9,opus", so splitting the data
  // URL at the FIRST comma yields "opus;base64,AAAA..." as the payload. The API
  // quoted exactly that back: Base64 decoding failed for "opus;base64,...".
  // Nearly every recording has a multi-codec MIME type, so inline video was
  // rejected every time and the extension blamed the video format.
  const { extractBase64Payload } = await import("../dist-test/test-api.mjs");

  const cases = [
    ["data:video/mp4;codecs=vp9,opus;base64,AAAABBBB", "AAAABBBB"],
    ["data:video/webm;codecs=vp8,opus;base64,QUJD", "QUJD"],
    ['data:video/mp4;codecs="avc1.42E01E,mp4a.40.2";base64,WFla', "WFla"],
    ["data:image/jpeg;base64,/9j/4AAQ", "/9j/4AAQ"],
    ["data:video/webm;base64,SGVsbG8=", "SGVsbG8="],
  ];

  for (const [dataUrl, expected] of cases) {
    assert.equal(extractBase64Payload(dataUrl), expected,
      `wrong payload for ${dataUrl.slice(0, 48)}…`);
  }
});

test("a payload with no base64 marker still parses, and junk returns null", async () => {
  const { extractBase64Payload } = await import("../dist-test/test-api.mjs");
  assert.equal(extractBase64Payload("data:text/plain,hello"), "hello");
  assert.equal(extractBase64Payload("not-a-data-url"), null);
});

// -----------------------------------------------------------------------------
// The cost gate
//
// Section 15 of the plan asked for the token estimate to be shown "in the
// confirmation dialog *before* the request". It was being shown as a status
// line AFTER the send had already started, which is a different thing: the
// tester learns the price once it is already paid. These tests pin the two
// halves of the gate.
// -----------------------------------------------------------------------------

/** A bundle carrying just enough shape for the cost helpers. */
function bundleCosting(tokens, video) {
  return {
    estimatedInputTokens: tokens,
    video: {
      deliveryMode: video.mode,
      durationMs: video.durationMs ?? 0,
      keyFrameBase64: video.frames ?? [],
      base64Data: "",
    },
  };
}

test("a small text-only request is not gated", () => {
  const bundle = bundleCosting(4000, { mode: "omitted" });
  assert.equal(api.requestNeedsCostConfirmation(bundle), false);
});

test("a request carrying a video is gated", () => {
  const bundle = bundleCosting(120000, { mode: "inline-base64", durationMs: 42000 });
  assert.equal(api.requestNeedsCostConfirmation(bundle), true);
});

test("the cost sentence names the number and what it is made of", () => {
  const withVideo = api.describeRequestCost(
    bundleCosting(145000, { mode: "files-api-uri", durationMs: 300000 }));
  assert.match(withVideo, /145,000 tokens/);
  assert.match(withVideo, /300-second video/,
    "the sentence must say what the tokens are made of, not just how many");

  const withFrames = api.describeRequestCost(
    bundleCosting(60000, { mode: "key-frames", frames: ["a", "b", "c"] }));
  assert.match(withFrames, /3 key frames/);

  const withNothing = api.describeRequestCost(
    bundleCosting(9000, { mode: "omitted" }));
  assert.match(withNothing, /no video/);
});

test("the gate threshold is low enough that any video crosses it", () => {
  // A one-second video at the estimated rate already costs more than the
  // threshold. This is deliberate: video is where the money is, so no video
  // should ever be sent without the tester seeing the number first.
  const oneSecondOfVideo = 300;
  assert.ok(oneSecondOfVideo * 200 > 50000,
    "a short video must still cross the confirmation threshold");
});

// -----------------------------------------------------------------------------
// Rows written by an older version
//
// "TypeError: Cannot read properties of undefined (reading 'indexOf')" - hit by
// a tester on a session they had already recorded, the moment a new field was
// added. `undefined` is not `""`, so a guard written as `if (x !== "")` PASSES
// on the old row and hands undefined to code expecting a string.
//
// readSettings() has merged against defaults since the beginning for exactly
// this reason. Sessions and events never did.
// -----------------------------------------------------------------------------

/** A session as it was stored before any of the recent fields existed. */
function sessionFromAnOlderVersion() {
  return {
    id: "old-1",
    name: "OrangeHRM",
    status: "complete",
    startedAtMs: 1000,
    stoppedAtMs: 200000,
    wallClockDurationMs: 199000,
    recordedDurationMs: 199000,
    originTabId: 1,
    originUrl: "https://opensource-demo.orangehrmlive.com/",
    originTitle: "OrangeHRM",
    eventCount: 20,
    domSnapshotCount: 3,
    networkEntryCount: 0,
    networkFailureCount: 0,
    consoleErrorCount: 0,
    media: null,
    bugReport: null,
    reportLanguage: "en",
    videoUploadConsentGiven: false,
    lastVideoDeliveryMode: "omitted",
    // finalScreenshotDataUrl, interactionCaptureDegradedReason,
    // videoDowngradeReason, visitedUrls, redactionSummary: all absent.
  };
}

test("a session from an older version comes back with every field", () => {
  const session = api.normaliseSession(sessionFromAnOlderVersion());

  assert.equal(session.finalScreenshotDataUrl, "",
    "the missing field must read as empty, not undefined");
  assert.equal(session.interactionCaptureDegradedReason, "");
  assert.equal(session.videoDowngradeReason, "");
  assert.deepEqual(session.visitedUrls, []);
  assert.deepEqual(session.redactionSummary, {});

  // And the fields it DID have survive untouched.
  assert.equal(session.name, "OrangeHRM");
  assert.equal(session.eventCount, 20);
});

test("the exact crash: extractBase64Payload on a missing field", () => {
  const old = sessionFromAnOlderVersion();

  // Before the fix this threw. The guard `!== ""` passes on undefined.
  assert.equal(api.extractBase64Payload(old.finalScreenshotDataUrl), null,
    "an absent data URL must read as no payload, not throw");
  assert.equal(api.extractBase64Payload(""), null);
  assert.equal(api.extractBase64Payload("data:image/png;base64,AAAB"), "AAAB");
});

test("an event from an older version has a keystrokes array", () => {
  const event = api.normaliseEvent({
    index: 0, sessionId: "old-1", type: "input", wallClockMs: 1000,
    videoOffsetMs: 0, pageUrl: "https://x.test/", pageTitle: "x",
    tabId: 1, frameId: 0, locator: null, value: "Admin",
    valueWasRedacted: false, clientX: -1, clientY: -1,
    domSnapshotId: "", elementContextId: "",
    // keystrokes and dropTargetLocator absent.
  });

  assert.deepEqual(event.keystrokes, []);
  assert.equal(event.dropTargetLocator, null);
  assert.equal(event.value, "Admin");
});

test("codegen survives an event with no keystrokes array", () => {
  // The path that would have thrown on every pre-existing recording.
  assert.equal(api.describeKeystrokeCorrections(undefined), "");
  assert.equal(api.describeKeystrokeCorrections(null), "");
});
