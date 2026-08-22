// =============================================================================
// src/shared/constants.ts
// Every tunable number and every model id. Nothing here is duplicated
// elsewhere, so tuning the system is a one-file job.
// =============================================================================

// -----------------------------------------------------------------------------
// AI model configuration
// -----------------------------------------------------------------------------

/**
 * The models the extension is allowed to use. The options page renders this as
 * a dropdown; the Gemini client falls back to DEFAULT_MODEL_ID if a stored
 * value is not on this list.
 *
 * CONFIRMED: "gemini-3.5-flash" exists and is multimodal - it has answered
 * live requests carrying text, page code and video. An earlier version of this
 * comment warned it might not exist, which was true when written and is not now.
 * This is still the only place a model id appears.
 */
export const SUPPORTED_MODELS: readonly string[] = [
  "gemini-3.5-flash",
];

/** The default model. Configurable in the options page. */
export const DEFAULT_MODEL_ID: string = "gemini-3.5-flash";

/**
 * CONFIRMED working: https://generativelanguage.googleapis.com/v1beta.
 */
export const GEMINI_API_BASE: string = "https://generativelanguage.googleapis.com";
export const GEMINI_API_VERSION: string = "v1beta";

// -----------------------------------------------------------------------------
// DOM capture budgets
// -----------------------------------------------------------------------------

/** Hard ceiling on one full-page pruned snapshot. */
export const MAX_SNAPSHOT_CHARACTERS: number = 40000;

/** How many full-page snapshots may be sent to the model. */
export const MAX_SNAPSHOTS_IN_BUNDLE: number = 4;

/** How many per-element contexts may be sent to the model. */
export const MAX_ELEMENT_CONTEXTS_IN_BUNDLE: number = 12;

/** How many action-trace steps before middle-truncation kicks in. */
export const MAX_ACTION_TRACE_STEPS: number = 60;

/** Minimum gap between two interaction-triggered snapshots. */
export const SNAPSHOT_THROTTLE_MS: number = 1500;

/** Longest single text node kept in a pruned snapshot. */
export const MAX_TEXT_NODE_CHARACTERS: number = 2000;

/** Longest class attribute kept in a pruned snapshot. */
export const MAX_CLASS_ATTRIBUTE_CHARACTERS: number = 120;

/** Longest value for any other kept attribute. */
export const MAX_ATTRIBUTE_VALUE_CHARACTERS: number = 200;

/** Element-context sub-budgets. */
export const MAX_ELEMENT_HTML_CHARACTERS: number = 2000;
export const MAX_ANCESTOR_HTML_CHARACTERS: number = 3000;
export const MAX_SIBLING_HTML_CHARACTERS: number = 400;
export const SIBLINGS_EACH_SIDE: number = 3;
export const MAX_ANCESTOR_LEVELS: number = 6;

// -----------------------------------------------------------------------------
// Interaction capture
// -----------------------------------------------------------------------------

/** How long we wait after the last keystroke before emitting one input event. */
export const INPUT_COALESCE_DELAY_MS: number = 600;

/** How long we watch for a DOM mutation before deciding a hover mattered. */
export const HOVER_MUTATION_WINDOW_MS: number = 250;

/** Minimum gap between two recorded hover events on different elements. */
export const HOVER_THROTTLE_MS: number = 800;

/** How long after a scroll an interaction still counts as "scroll then act". */
export const SCROLL_RELEVANCE_WINDOW_MS: number = 2000;

/** Window in which a failed request is attributed to a preceding interaction. */
export const FAILURE_ATTRIBUTION_WINDOW_MS: number = 3000;

/** Longest visible text we will use to build a text locator. */
export const MAX_VISIBLE_TEXT_CHARACTERS: number = 120;

/** How deep a CSS path may go before we give up and use XPath. */
export const MAX_CSS_PATH_DEPTH: number = 6;

// -----------------------------------------------------------------------------
// Media capture
// -----------------------------------------------------------------------------

export const TARGET_VIDEO_WIDTH: number = 1280;
export const TARGET_VIDEO_HEIGHT: number = 720;
export const TARGET_FRAME_RATE: number = 10;
export const TARGET_VIDEO_BITS_PER_SECOND: number = 1_000_000;
export const TARGET_AUDIO_BITS_PER_SECOND: number = 64_000;

/** MediaRecorder timeslice: chunks arrive continuously, not only at stop. */
export const RECORDER_CHUNK_INTERVAL_MS: number = 2000;

/**
 * Container/codec preference order.
 * CONFIRMED on Chromium 149: the first entry is supported and produces
 * "video/mp4;codecs=vp9,opus", which the model accepts. The list is still
 * probed at runtime rather than assumed, because an older Chrome will fall
 * through to WebM.
 */
export const PREFERRED_RECORDING_MIME_TYPES: readonly string[] = [
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  "video/mp4",
  'video/webm;codecs="vp9,opus"',
  'video/webm;codecs="vp8,opus"',
  "video/webm",
];

// -----------------------------------------------------------------------------
// Video delivery to the model
// -----------------------------------------------------------------------------

/** Above this we never send video; key frames only. */
export const VIDEO_HARD_SIZE_CEILING_BYTES: number = 200 * 1024 * 1024;

/** Above this duration, likewise. VERIFY the model's real duration limit. */
export const VIDEO_HARD_DURATION_CEILING_MS: number = 10 * 60 * 1000;

/** Below this, inlining base64 beats an upload round trip. */
export const VIDEO_INLINE_THRESHOLD_BYTES: number = 2 * 1024 * 1024;

export const KEY_FRAME_COUNT: number = 6;
export const KEY_FRAME_JPEG_QUALITY: number = 0.7;
export const KEY_FRAME_MAX_WIDTH: number = 1280;

/**
 * MIME types we believe the model accepts.
 * PARTIALLY CONFIRMED: video/mp4 is accepted - a real recording was sent inline
 * and via the Files API, and analysed. The other three entries are still
 * assumptions; in particular video/webm has never been tested, because
 * Chromium 149 always chose MP4 for recording.
 *
 * If an entry here is wrong, that session silently takes the key-frame path -
 * which works, but you would want to know.
 */
export const ASSUMED_SUPPORTED_VIDEO_MIME_TYPES: readonly string[] = [
  "video/mp4",
  "video/webm",
  "video/mov",
  "video/mpeg",
];

// -----------------------------------------------------------------------------
// Network and console capture
// -----------------------------------------------------------------------------

export const MAX_BODY_EXCERPT_CHARACTERS: number = 2000;
export const MAX_STACK_EXCERPT_CHARACTERS: number = 800;

// NOTE: there is deliberately no request-header allow-list here. The
// MAIN-world fetch/XHR patch does not read request headers at all, so
// NetworkEntry.requestHeaders is always empty. Redaction still strips
// Authorization and Cookie if a future capture path ever populates it.

// -----------------------------------------------------------------------------
// Gemini request handling
// -----------------------------------------------------------------------------

export const MAX_API_ATTEMPTS: number = 3;
export const BASE_BACKOFF_MS: number = 2000;

/** Low, because the task is evidence transcription, not creative writing. */
export const REPORT_TEMPERATURE: number = 0.2;

/** Rough characters-per-token used for local estimates only. */
export const ESTIMATED_CHARACTERS_PER_TOKEN: number = 4;

/**
 * Above this estimated input size, the tester is asked to confirm before the
 * request is sent.
 *
 * WHY a threshold rather than always asking: a dialog on every generation is a
 * dialog people learn to dismiss without reading, which is worse than no dialog.
 * A short session costs little and should just run. This number is deliberately
 * low enough that any session carrying a video crosses it, because the video is
 * where the cost actually is.
 */
export const CONFIRM_ABOVE_ESTIMATED_TOKENS: number = 50000;

/** VERIFY: the per-second video token rate for your model. Placeholder. */
export const ESTIMATED_VIDEO_TOKENS_PER_SECOND: number = 300;

/** VERIFY: the per-image token cost. Placeholder. */
export const ESTIMATED_TOKENS_PER_KEY_FRAME: number = 300;

/**
 * How long the generated script waits between steps, in milliseconds.
 *
 * Three seconds, because the first person to run a generated script is the
 * tester who just recorded it, and they are running it to WATCH it. A replay
 * that finishes before they have focused the window proves nothing to them.
 * The script reads STEP_PAUSE_MS from the environment, so CI sets it to 0.
 */
export const DEFAULT_STEP_PAUSE_MS: number = 3000;

// -----------------------------------------------------------------------------
// Storage
// -----------------------------------------------------------------------------

export const MINIMUM_FREE_BYTES_TO_START: number = 500 * 1024 * 1024;
export const DEFAULT_RETENTION_DAYS: number = 0;
export const CLEANUP_PROMPT_AFTER_BYTES: number = 300 * 1024 * 1024;

// -----------------------------------------------------------------------------
// Fixed strings the pipeline depends on
// -----------------------------------------------------------------------------

/**
 * The exact sentence the model must emit when Expected Behavior cannot be
 * derived from the evidence. Compared byte-for-byte by validateBugReport().
 */
export const NOT_DETERMINABLE_SENTENCE: string =
  "Expected behavior not determinable from the recording — requires tester input.";

/** Namespace for the MAIN-world <-> ISOLATED-world postMessage bridge. */
export const BRIDGE_CHANNEL: string = "TESTER_REPORTER_AI_BRIDGE";
