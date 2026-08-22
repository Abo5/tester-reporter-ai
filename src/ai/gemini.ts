// =============================================================================
// src/ai/gemini.ts
// The only file that talks to Google.
//
// EVERYTHING here is VERIFY territory: endpoint paths, header names, body field
// names, the upload handshake and the response envelope all change between
// Gemini releases. Make one real call by hand and write down what came back
// BEFORE trusting a line of this file.
//
// It never throws for an expected failure. Every expected failure has a UI
// state that must still show the tester their video and their script, so the
// outcome is returned as a typed value instead.
// =============================================================================

import type {
  AIEvidenceBundle,
  GeneratedBugReport,
  RecordedEvent,
} from "../shared/types";
import { SYSTEM_INSTRUCTION, buildEvidenceText } from "./prompt";
import { BUG_REPORT_RESPONSE_SCHEMA } from "./schema";
import {
  validateBugReport,
  reconcileEvidenceUsed,
  normaliseExpectedBehavior,
} from "./validate";
import { downgradeVideoToKeyFrames } from "./video";
import {
  SUPPORTED_MODELS,
  DEFAULT_MODEL_ID,
  GEMINI_API_BASE,
  GEMINI_API_VERSION,
  MAX_API_ATTEMPTS,
  BASE_BACKOFF_MS,
  REPORT_TEMPERATURE,
} from "../shared/constants";
import { logInfo, logWarning } from "../shared/logger";

/** Every outcome the caller has to handle. Named so the UI can switch on it. */
export type GeminiOutcome =
  | { kind: "success"; report: GeneratedBugReport; rawResponseText: string;
      bundleUsed: AIEvidenceBundle }
  | { kind: "no-api-key" }
  | { kind: "offline" }
  | { kind: "rate-limited"; attemptsMade: number }
  | { kind: "safety-blocked"; rawResponseText: string }
  | { kind: "empty-response"; rawResponseText: string }
  | { kind: "malformed-json"; rawResponseText: string; problems: string[] }
  | { kind: "http-error"; statusCode: number; message: string }
  | { kind: "upload-failed"; message: string };

export interface GeminiRequestOptions {
  apiKey: string;
  modelId: string;
  bundle: AIEvidenceBundle;
  videoBlob: Blob | null;
  /** Needed only to re-derive key frames if an upload fails mid-request. */
  events: RecordedEvent[];
  failureEventIndexes: number[];
}

/**
 * Guards against a model id that is not on the supported list.
 *
 * WHY: the model id is user-editable in settings, and a typo would otherwise
 * produce a confusing 404 from Google rather than a clear local error.
 */
export function resolveModelId(requestedModelId: string): string {
  for (let index = 0; index < SUPPORTED_MODELS.length; index = index + 1) {
    if (SUPPORTED_MODELS[index] === requestedModelId) {
      return requestedModelId;
    }
  }
  return DEFAULT_MODEL_ID;
}

/** Sleeps for a number of milliseconds. Used only for retry backoff. */
function delay(milliseconds: number): Promise<void> {
  return new Promise<void>(function executor(resolve): void {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Uploads the video to the Files API and returns its URI.
 *
 * VERIFY: THIS ENTIRE FUNCTION IS A SKETCH OF THE FLOW, NOT VERIFIED CODE. The
 * shape below is a two-step resumable upload: a POST that starts the upload and
 * returns an upload URL in a response header, then a second request carrying
 * the bytes. The header names, the response shape, the field that holds the file
 * URI, and the retention period must ALL be read from current documentation.
 * Do not ship this from memory.
 */
async function uploadVideoToFilesApi(
  apiKey: string,
  videoBlob: Blob,
  mimeType: string,
): Promise<string> {
  const startResponse: Response = await fetch(
    GEMINI_API_BASE + "/upload/" + GEMINI_API_VERSION + "/files",
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(videoBlob.size),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: "qa-session-recording" } }),
    },
  );

  if (!startResponse.ok) {
    throw new Error(
      "Upload could not be started: HTTP " + String(startResponse.status));
  }

  const uploadUrl: string | null = startResponse.headers.get("x-goog-upload-url");
  if (uploadUrl === null || uploadUrl === "") {
    throw new Error(
      "The upload start response did not contain an upload URL. VERIFY the "
      + "header name against current documentation.");
  }

  const uploadResponse: Response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: videoBlob,
  });

  if (!uploadResponse.ok) {
    throw new Error("Video upload failed: HTTP " + String(uploadResponse.status));
  }

  const uploadResult: unknown = await uploadResponse.json();
  const typedResult = uploadResult as { file?: { uri?: string; name?: string } };
  const fileUri: string | undefined = typedResult.file?.uri;

  if (fileUri === undefined || fileUri === "") {
    throw new Error(
      "The upload response did not contain a file URI. VERIFY the response "
      + "shape against current documentation.");
  }

  logInfo("gemini", "Video uploaded: " + fileUri);
  return fileUri;
}

/**
 * Deletes an uploaded file after the report is generated.
 *
 * WHY we bother: there is no reason for a QA recording of a staging environment
 * to sit on someone else's storage a minute longer than the request needs it.
 *
 * VERIFY: the delete endpoint path and whether the Files API exposes one at
 * all. Failure here is logged and ignored: the report has already been produced
 * and the tester should not see an error about cleanup.
 */
export async function deleteUploadedFile(
  apiKey: string,
  fileUri: string,
): Promise<void> {
  if (fileUri === "") {
    return;
  }
  try {
    await fetch(fileUri, {
      method: "DELETE",
      headers: { "x-goog-api-key": apiKey },
    });
    logInfo("gemini", "Uploaded video deleted from the Files API.");
  } catch (deleteError: unknown) {
    logWarning("gemini", "Could not delete the uploaded video.", deleteError);
  }
}

/**
 * Builds the request body.
 *
 * VERIFY: every field name in this object, especially the structured-output
 * ones. Google has renamed this area between releases: responseMimeType,
 * response_mime_type, responseSchema and response_json_schema have all existed
 * at various points, and the accepted subset of JSON Schema has changed.
 */
function buildRequestBody(
  bundle: AIEvidenceBundle,
  fileUri: string,
): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [];

  parts.push({ text: buildEvidenceText(bundle) });

  if (bundle.video.deliveryMode === "files-api-uri" && fileUri !== "") {
    parts.push({
      file_data: { mime_type: bundle.video.mimeType, file_uri: fileUri },
    });
  } else if (bundle.video.deliveryMode === "inline-base64") {
    parts.push({
      inline_data: {
        mime_type: bundle.video.mimeType,
        data: bundle.video.base64Data,
      },
    });
  } else if (bundle.video.deliveryMode === "key-frames") {
    for (let index = 0; index < bundle.video.keyFrameBase64.length;
         index = index + 1) {
      parts.push({
        inline_data: {
          mime_type: "image/jpeg",
          data: bundle.video.keyFrameBase64[index],
        },
      });
    }
  }

  return {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: "user", parts: parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: BUG_REPORT_RESPONSE_SCHEMA,
      temperature: REPORT_TEMPERATURE,
    },
  };
}

/**
 * Pulls the model's text out of the response envelope.
 *
 * VERIFY: candidates[0].content.parts[0].text is the shape assumed here.
 */
function extractResponseText(responseJson: unknown): string {
  const typed = responseJson as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const candidates = typed.candidates;
  if (candidates === undefined || candidates.length === 0) {
    return "";
  }
  const parts = candidates[0].content?.parts;
  if (parts === undefined || parts.length === 0) {
    return "";
  }

  // Concatenate every text part: a long JSON response can be split across them.
  let combined: string = "";
  for (let index = 0; index < parts.length; index = index + 1) {
    const text: string | undefined = parts[index].text;
    if (typeof text === "string") {
      combined = combined + text;
    }
  }
  return combined;
}

/**
 * True when the response indicates a safety or policy block rather than content.
 *
 * VERIFY: where a block is reported. The shape assumed here is a
 * promptFeedback.blockReason and/or a candidate finishReason of SAFETY.
 */
function isSafetyBlocked(responseJson: unknown): boolean {
  const typed = responseJson as {
    promptFeedback?: { blockReason?: string };
    candidates?: { finishReason?: string }[];
  };
  if (typed.promptFeedback?.blockReason !== undefined) {
    return true;
  }
  const candidates = typed.candidates;
  if (candidates !== undefined && candidates.length > 0) {
    const finishReason: string | undefined = candidates[0].finishReason;
    if (finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT"
        || finishReason === "BLOCKLIST" || finishReason === "SPII") {
      return true;
    }
  }
  return false;
}

/**
 * Strips a markdown fence if the model wrapped its JSON in one anyway.
 *
 * WHY, given we asked for raw JSON and used schema-constrained output: because
 * a five-line guard is cheaper than a support ticket, and this specific failure
 * is extremely common across every model and provider.
 */
function stripMarkdownFence(text: string): string {
  const trimmed: string = text.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  const firstNewline: number = trimmed.indexOf("\n");
  if (firstNewline === -1) {
    return trimmed;
  }
  let body: string = trimmed.slice(firstNewline + 1);
  if (body.trimEnd().endsWith("```")) {
    const lastFence: number = body.lastIndexOf("```");
    body = body.slice(0, lastFence);
  }
  return body.trim();
}

/**
 * Generates the bug report.
 *
 * The order of the guards matters: we check for a missing key and for being
 * offline BEFORE spending anything, and we refuse outright to send a bundle
 * that has not been through the redaction gate.
 */
export async function generateBugReport(
  options: GeminiRequestOptions,
): Promise<GeminiOutcome> {
  if (options.apiKey.trim() === "") {
    return { kind: "no-api-key" };
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { kind: "offline" };
  }
  if (!options.bundle.redactionCompleted) {
    // Defence in depth: this should be impossible, because buildEvidenceBundle
    // throws on redaction failure. If it ever happens, refuse to send.
    throw new Error("Refusing to call the AI with an unredacted evidence bundle.");
  }

  const modelId: string = resolveModelId(options.modelId);
  let workingBundle: AIEvidenceBundle = options.bundle;

  // --- Step 1: upload the video, if that is the chosen delivery mode. -------
  let fileUri: string = "";
  if (workingBundle.video.deliveryMode === "files-api-uri") {
    if (options.videoBlob === null) {
      workingBundle = {
        ...workingBundle,
        video: {
          ...workingBundle.video,
          deliveryMode: "omitted",
          downgradeReason:
            "The recorded video could not be read from storage, so the report "
            + "was written from the page code and the action script only.",
        },
      };
    } else {
      try {
        fileUri = await uploadVideoToFilesApi(
          options.apiKey,
          options.videoBlob,
          workingBundle.video.mimeType,
        );
      } catch (uploadError: unknown) {
        // A failed upload must NOT abort the report. Degrade to key frames.
        logWarning("gemini", "Video upload failed; degrading.", uploadError);
        const downgraded = await downgradeVideoToKeyFrames(
          options.videoBlob,
          workingBundle.video,
          options.events,
          options.failureEventIndexes,
          "The video could not be uploaded (" + String(uploadError) + ").",
        );
        workingBundle = { ...workingBundle, video: downgraded };
      }
    }
  }

  const requestBody: Record<string, unknown> =
    buildRequestBody(workingBundle, fileUri);

  // VERIFY: the path and the ":generateContent" method suffix.
  const endpointUrl: string =
    GEMINI_API_BASE + "/" + GEMINI_API_VERSION + "/models/"
    + modelId + ":generateContent";

  let lastRawText: string = "";
  let lastValidationProblems: string[] = [];
  let hasRetriedForBadOutput: boolean = false;

  try {
    for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt = attempt + 1) {
      let response: Response;
      try {
        response = await fetch(endpointUrl, {
          method: "POST",
          headers: {
            "x-goog-api-key": options.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        });
      } catch (networkError: unknown) {
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          return { kind: "offline" };
        }
        if (attempt === MAX_API_ATTEMPTS) {
          return {
            kind: "http-error",
            statusCode: 0,
            message: "Network request failed: " + String(networkError),
          };
        }
        await delay(BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
        continue;
      }

      // --- 429: exponential backoff, at most MAX_API_ATTEMPTS in total. ----
      if (response.status === 429) {
        if (attempt === MAX_API_ATTEMPTS) {
          return { kind: "rate-limited", attemptsMade: attempt };
        }
        await delay(BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
        continue;
      }

      // --- 5xx: also worth retrying. ---------------------------------------
      if (response.status >= 500) {
        if (attempt === MAX_API_ATTEMPTS) {
          return {
            kind: "http-error",
            statusCode: response.status,
            message: "The AI service returned a server error.",
          };
        }
        await delay(BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
        continue;
      }

      // --- 4xx: retrying a rejected request just wastes time. --------------
      if (response.status === 400 || response.status === 401
          || response.status === 403 || response.status === 404) {
        const errorText: string = await response.text();
        return {
          kind: "http-error",
          statusCode: response.status,
          message:
            "The request was rejected. Check the API key and the model id in "
            + "settings. Response: " + errorText.slice(0, 600),
        };
      }

      if (!response.ok) {
        return {
          kind: "http-error",
          statusCode: response.status,
          message: "Unexpected HTTP " + String(response.status) + ".",
        };
      }

      const responseJson: unknown = await response.json();

      if (isSafetyBlocked(responseJson)) {
        return {
          kind: "safety-blocked",
          rawResponseText: JSON.stringify(responseJson, null, 2),
        };
      }

      const rawText: string = extractResponseText(responseJson);
      lastRawText = rawText;

      if (rawText.trim() === "") {
        return {
          kind: "empty-response",
          rawResponseText: JSON.stringify(responseJson, null, 2),
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stripMarkdownFence(rawText));
      } catch (parseError: unknown) {
        if (!hasRetriedForBadOutput) {
          hasRetriedForBadOutput = true;
          continue;   // One retry, exactly as specified.
        }
        return {
          kind: "malformed-json",
          rawResponseText: rawText,
          problems: ["The response was not valid JSON: " + String(parseError)],
        };
      }

      const validation = validateBugReport(parsed);
      if (!validation.isValid) {
        lastValidationProblems = validation.problems;
        if (!hasRetriedForBadOutput) {
          hasRetriedForBadOutput = true;
          continue;   // One retry, exactly as specified.
        }
        return {
          kind: "malformed-json",
          rawResponseText: rawText,
          problems: validation.problems,
        };
      }

      const videoWasSent: boolean =
        workingBundle.video.deliveryMode !== "omitted";
      const networkOrConsoleWasSent: boolean =
        workingBundle.networkFailures.length > 0
        || workingBundle.consoleErrors.length > 0;
      const pageCodeWasSent: boolean =
        workingBundle.domSnapshots.length > 0
        || workingBundle.elementContext.length > 0;

      const reconciledReport: GeneratedBugReport = reconcileEvidenceUsed(
        normaliseExpectedBehavior(parsed as GeneratedBugReport),
        videoWasSent,
        networkOrConsoleWasSent,
        pageCodeWasSent,
      );

      return {
        kind: "success",
        report: reconciledReport,
        rawResponseText: rawText,
        bundleUsed: workingBundle,
      };
    }

    return {
      kind: "malformed-json",
      rawResponseText: lastRawText,
      problems:
        lastValidationProblems.length > 0
          ? lastValidationProblems
          : ["Exhausted all attempts without a valid response."],
    };
  } finally {
    // Clean up the uploaded file whatever happened above.
    if (fileUri !== "") {
      void deleteUploadedFile(options.apiKey, fileUri);
    }
  }
}
