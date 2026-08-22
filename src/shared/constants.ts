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
 * VERIFY: every id below. As of the author's knowledge cutoff (May 2026) the
 * existence of "gemini-3.5-flash" could NOT be confirmed. Check the official
 * model list and replace these strings with real ids before shipping. This is
 * the only place they appear.
 */
export const SUPPORTED_MODELS: readonly string[] = [
  "gemini-3.5-flash",
];

/** The default model. Configurable in the options page. */
export const DEFAULT_MODEL_ID: string = "gemini-3.5-flash";

/**
 * VERIFY: the base URL and version path against current Gemini documentation.
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
 * VERIFY: run MediaRecorder.isTypeSupported() in YOUR target Chrome. MP4 is far
 * more likely to be accepted by a multimodal API and by every player, but
 * Chrome gained MP4 recording relatively recently.
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
 * VERIFY THIS ENTIRE LIST against current Gemini video documentation. If
 * video/webm is not on it and the browser cannot record MP4, every session
 * silently takes the key-frame path, which works but you would want to know.
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

/** Request headers we are willing to store at all. */
export const ALLOWED_REQUEST_HEADERS: readonly string[] = [
  "content-type",
  "accept",
  "accept-language",
  "x-requested-with",
];

// -----------------------------------------------------------------------------
// Gemini request handling
// -----------------------------------------------------------------------------

export const MAX_API_ATTEMPTS: number = 3;
export const BASE_BACKOFF_MS: number = 2000;

/** Low, because the task is evidence transcription, not creative writing. */
export const REPORT_TEMPERATURE: number = 0.2;

/** Rough characters-per-token used for local estimates only. */
export const ESTIMATED_CHARACTERS_PER_TOKEN: number = 4;

/** VERIFY: the per-second video token rate for your model. Placeholder. */
export const ESTIMATED_VIDEO_TOKENS_PER_SECOND: number = 300;

/** VERIFY: the per-image token cost. Placeholder. */
export const ESTIMATED_TOKENS_PER_KEY_FRAME: number = 300;

// -----------------------------------------------------------------------------
// Storage
// -----------------------------------------------------------------------------

export const MINIMUM_FREE_BYTES_TO_START: number = 500 * 1024 * 1024;
export const DEFAULT_RETENTION_DAYS: number = 0;
export const CLEANUP_PROMPT_AFTER_SESSIONS: number = 5;
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
