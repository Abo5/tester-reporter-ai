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
