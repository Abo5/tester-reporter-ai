// =============================================================================
// tests/live/files-api.live.mjs
//
// uploadVideoToFilesApi has carried a comment since it was written saying it is
// a SKETCH of the flow, not verified code: a two-step resumable upload whose
// header names, response shape and file-URI field were all written from memory.
// A recording under the inline threshold never touches it, so it had never run.
//
// This runs it against the real API with a real MP4.
// =============================================================================

import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const api = await import("../../dist-test/test-api.mjs");

const API_KEY = (process.env.GEMINI_API_KEY ?? "").trim();
const HAVE_KEY = API_KEY !== "";

/** A real recording produced by the browser suite, if one is around. */
const CAPTURE_PATH = path.resolve(
  "/tmp/claude-1000/-home-panda-Desktop-Tester-Reporter-AI",
  "45e7ecad-a1fd-42ee-aae6-f084392d2708/scratchpad/cap.mp4");

let videoBytes = null;

before(() => {
  if (fs.existsSync(CAPTURE_PATH)) {
    videoBytes = fs.readFileSync(CAPTURE_PATH);
  }
});

test("the Files API upload path works against the real service", async (t) => {
  if (!HAVE_KEY) {
    t.skip("no GEMINI_API_KEY in .env");
    return;
  }
  if (videoBytes === null) {
    t.skip("no recorded capture available; run npm run test:e2e:video first");
    return;
  }

  const blob = new Blob([videoBytes], { type: "video/mp4" });
  console.log(`  uploading ${blob.size} bytes as video/mp4`);

  let fileUri;
  try {
    fileUri = await api.uploadVideoToFilesApi(API_KEY, blob, "video/mp4");
  } catch (uploadError) {
    assert.fail(
      "the Files API upload failed. This is the function whose header names, "
      + "response shape and URI field were written from memory:\n"
      + String(uploadError));
  }

  console.log(`  file uri: ${fileUri}`);
  assert.ok(typeof fileUri === "string" && fileUri.length > 0);
  assert.ok(fileUri.startsWith("http") || fileUri.includes("files/"),
    `the returned URI does not look like a file reference: ${fileUri}`);

  // An uploaded file is not immediately usable; poll until it is ACTIVE.
  const deadline = Date.now() + 60000;
  let state = "";
  while (Date.now() < deadline) {
    const response = await fetch(fileUri, { headers: { "x-goog-api-key": API_KEY } });
    if (!response.ok) {
      break;
    }
    const info = await response.json();
    state = info.state ?? "";
    if (state !== "PROCESSING") {
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`  file state: ${state || "(not reported)"}`);

  // The point of the exercise: can the model actually read it back by URI?
  const model = (process.env.GEMINI_MODEL ?? "gemini-3.5-flash").trim();
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: "In one sentence, what does this screen recording show?" },
            { file_data: { mime_type: "video/mp4", file_uri: fileUri } },
          ],
        }],
      }),
    });

  const text = await response.text();
  console.log(`  generateContent with file_uri -> HTTP ${response.status}`);
  assert.equal(response.status, 200,
    `the model could not read the uploaded file:\n${text.slice(0, 600)}`);

  const parsed = JSON.parse(text);
  const answer = parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  console.log(`  model said: ${answer.slice(0, 160)}`);
  assert.ok(answer.length > 0, "the model returned nothing for the uploaded file");

  // Clean up: a QA recording should not linger on someone else's storage.
  await api.deleteUploadedFile(API_KEY, fileUri);
  console.log("  deleted from the Files API");
});
