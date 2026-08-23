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

/**
 * Above this duration we send key frames instead of the video.
 *
 * CONFIRMED against the official video-understanding documentation: a model
 * with a 1M-token context window accepts video up to ONE HOUR at default media
 * resolution. This ceiling is deliberately far below that, and the reason is
 * cost rather than capability: an hour of video is roughly 1,080,000 input
 * tokens at 300 tokens/second, which would not fit the context alongside the
 * page code and would cost more than the whole session is worth. Ten minutes is
 * about 180,000 tokens, which is a defensible bill for one bug report.
 *
 * Raise it if you are analysing long journeys and have read the cost estimate
 * in the review page first.
 */
export const VIDEO_HARD_DURATION_CEILING_MS: number = 10 * 60 * 1000;

/**
 * The model's OWN limit, for the record. We never approach it.
 * Source: the video-understanding documentation, default media resolution.
 */
export const MODEL_VIDEO_DURATION_LIMIT_MS: number = 60 * 60 * 1000;

/** Below this, inlining base64 beats an upload round trip. */
export const VIDEO_INLINE_THRESHOLD_BYTES: number = 2 * 1024 * 1024;

export const KEY_FRAME_COUNT: number = 6;
export const KEY_FRAME_JPEG_QUALITY: number = 0.7;
export const KEY_FRAME_MAX_WIDTH: number = 1280;

/**
 * MIME types the model accepts.
 * PARTIALLY CONFIRMED: video/mp4 is accepted - a real recording was sent inline
 * and via the Files API, and analysed. The other three entries are still
 * assumptions; in particular video/webm has never been tested, because
 * Chromium 149 always chose MP4 for recording.
 *
 * CONFIRMED against the official video-understanding documentation. video/mp4
 * is additionally confirmed by running it: a real recording was sent inline and
 * via the Files API and analysed. The rest come from that list.
 *
 * If an entry here were wrong, that session would silently take the key-frame
 * path - which works, but you would want to know.
 */
export const SUPPORTED_VIDEO_MIME_TYPES: readonly string[] = [
  "video/mp4",
  "video/mpeg",
  "video/mov",
  "video/avi",
  "video/x-flv",
  "video/mpg",
  "video/webm",
  "video/wmv",
  "video/3gpp",
];

/**
 * Kept as the old name so nothing that imports it breaks.
 * @deprecated Use SUPPORTED_VIDEO_MIME_TYPES; these are no longer assumptions.
 */
export const ASSUMED_SUPPORTED_VIDEO_MIME_TYPES: readonly string[] =
  SUPPORTED_VIDEO_MIME_TYPES;

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

/**
 * Input tokens per second of video.
 *
 * CONFIRMED: "approximately 300 tokens per second of video at default media
 * resolution, or 100 tokens per second at low media resolution" - the official
 * video-understanding documentation. The placeholder that sat here was already
 * 300, which was luck rather than knowledge; it is now sourced.
 */
export const ESTIMATED_VIDEO_TOKENS_PER_SECOND: number = 300;

/**
 * Input tokens per key frame.
 *
 * CONFIRMED: an image costs 258 tokens when both dimensions are 384px or under,
 * and larger images are tiled at 258 tokens per 768x768 tile - the official
 * image-understanding documentation.
 *
 * Key frames are capped at KEY_FRAME_MAX_WIDTH (1280) and are therefore tiled,
 * not flat-rate. A 1280x720 frame has a crop unit of floor(720 / 1.5) = 480, so
 * ceil(1280/480) x ceil(720/480) = 3 x 2 = 6 tiles, which is 1,548 tokens. The
 * old placeholder of 300 understated a key-frame session FIVEFOLD - and the
 * key-frame path is the fallback for exactly the long recordings where cost
 * matters most.
 */
export const ESTIMATED_TOKENS_PER_KEY_FRAME: number = 1548;

/**
 * Price per million INPUT tokens, in US dollars, for the default model.
 *
 * CONFIRMED for gemini-3.5-flash on the official pricing page: $1.50 per 1M
 * input tokens, $9.00 per 1M output. Only the input figure is used here,
 * because a bug report's output is a few hundred tokens against tens of
 * thousands of evidence.
 *
 * A PRICE IN A CONSTANT GOES STALE. It is shown as "about", next to the token
 * count, which is the figure that does not change. If the estimate ever looks
 * wrong, the token count is the one to trust and this is the number to check.
 */
export const INPUT_PRICE_PER_MILLION_TOKENS_USD: number = 1.50;

/**
 * How long the generated script waits between steps, in milliseconds.
 *
 * Three seconds, because the first person to run a generated script is the
 * tester who just recorded it, and they are running it to WATCH it. A replay
 * that finishes before they have focused the window proves nothing to them.
 * The script reads STEP_PAUSE_MS from the environment, so CI sets it to 0.
 */
export const DEFAULT_STEP_PAUSE_MS: number = 3000;

/**
 * Longest real pause reproduced in the generated script, in milliseconds.
 *
 * The script now waits the time the tester ACTUALLY waited between actions, so
 * a replay reproduces their pace - which matters, because a defect that only
 * appears when a session token expires, or when a debounce settles, or when the
 * tester stared at a screen for ten seconds before the toast disappeared, does
 * not reproduce at machine speed.
 *
 * Capped, because a tester who answered the phone mid-session should not turn
 * their spec into a four-minute pause. Anything longer than this is emitted as
 * the cap plus a comment saying what the real gap was, so the reader can put it
 * back if the defect depends on it.
 */
export const MAX_REPLAYED_GAP_MS: number = 15000;

/**
 * Time budget a generated spec allows for the ACTIONS, before its own waits.
 *
 * Playwright's own default is 30s and that is what the actions get here too;
 * everything the script waits for deliberately is added on top of it.
 */
export const BASE_SPEC_TIMEOUT_MS: number = 30000;

/**
 * Shortest real gap worth emitting. Below this, the pause helper covers it.
 */
export const MIN_REPLAYED_GAP_MS: number = 400;

/**
 * Delay between characters when the generated script types, in milliseconds.
 *
 * Non-zero on purpose. The point of typing character by character rather than
 * calling fill() is to fire the events a real keyboard fires, and an
 * application that debounces on a 50ms window sees zero-delay typing as one
 * paste. This is also slow enough to watch, which is the other reason the
 * script exists.
 */
export const TYPING_DELAY_MS: number = 60;

/**
 * How long the final screenshot may take before it is given up on.
 *
 * Short, because it sits in front of stopping the recorder. See
 * captureFinalScreenshot for what a longer wait cost.
 */
export const FINAL_SCREENSHOT_TIMEOUT_MS: number = 2000;

/** Most individual keys stored for one field. See RecordedEvent.keystrokes. */
export const MAX_KEYSTROKES_PER_FIELD: number = 200;

/**
 * How often a mouse path is sampled, in milliseconds.
 *
 * A browser reports pointer movement at the display refresh rate, so recording
 * every event would be roughly sixty entries per second of idle hand movement -
 * hundreds of thousands in a long session, none of which anyone reads. Sampling
 * at this interval keeps the SHAPE of the movement, which is what tells a
 * reviewer the tester hunted around the screen before finding the control.
 */
export const MOUSE_PATH_SAMPLE_MS: number = 120;

/** Most points kept in one mouse-path event before it is flushed. */
export const MAX_MOUSE_PATH_POINTS: number = 40;

/** A path shorter than this in pixels is hand tremor, not a movement. */
export const MIN_MOUSE_PATH_DISTANCE_PX: number = 60;

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

// -----------------------------------------------------------------------------
// Trial and licensing
//
// See src/shared/licence.ts for what this layer does and does not achieve, and
// PLAN.md section 24 for the server contract that makes it real.
// -----------------------------------------------------------------------------

/** Length of the free trial, in days. */
export const TRIAL_DAYS: number = 14;

/**
 * Where a licence key is verified.
 *
 * EMPTY BY DEFAULT, and that is the honest state: with no endpoint the check is
 * local, which means a determined customer can bypass it. Set this to your own
 * server and the enforcement becomes real without another line changing here.
 *
 * The host must also be added to host_permissions in the manifest, or the
 * service worker cannot fetch it.
 *
 * ⚠️ VERIFY: the contract in PLAN.md section 24 is a DESIGN, not a description
 * of something that exists. Nothing has been built or tested against it.
 */
export const LICENCE_VERIFY_ENDPOINT: string = "";

/**
 * Where the customer is sent to pay.
 *
 * ⚠️ VERIFY: this must be replaced with the real PayPal link before shipping.
 * It is deliberately left empty rather than filled with a guess - a wrong
 * payment link sends money to the wrong place, or nowhere, and neither failure
 * announces itself. See PLAN.md section 24 for how to create the link.
 */
export const PAYPAL_CHECKOUT_URL: string = "";

/** Shown next to the payment button so the customer knows what they are buying. */
export const LICENCE_PRICE_DISPLAY: string = "";

// -----------------------------------------------------------------------------
// How the extension reaches Gemini
//
// The tester no longer supplies a key. There are two ways to give them access,
// and the difference between them is money.
// -----------------------------------------------------------------------------

/**
 * A Gemini API key compiled into the extension.
 *
 * ⚠️ READ THIS BEFORE FILLING IT IN.
 *
 * A key here is a PUBLISHED key. A Chrome extension is unpacked JavaScript on
 * every customer's disk: anyone who installs it can open the folder, or the
 * built bundle in DevTools, and read this string in about ten seconds. It is
 * not obfuscatable in any meaningful sense - a value the program must send has
 * to exist in the program.
 *
 * The bill for that key is yours, it has no per-user ceiling, and the first
 * sign of a problem is usually the invoice. If you ship a key here, treat it as
 * public: put a hard quota on it in Google AI Studio, keep it separate from
 * every other key you own, and be ready to rotate it.
 *
 * GEMINI_PROXY_ENDPOINT below does the same job without that exposure, and you
 * already need a server for licences.
 */
declare const __TRA_GEMINI_KEY__: string;
export const BUILT_IN_GEMINI_API_KEY: string =
  typeof __TRA_GEMINI_KEY__ === "string" ? __TRA_GEMINI_KEY__ : "";

/**
 * Your own endpoint, which holds the key and calls Gemini on the extension's
 * behalf.
 *
 * WHY this is the better half of the pair: the customer still enters nothing,
 * the key never leaves your server, and you can refuse a request from an
 * expired licence before it costs you a token - which a key compiled into the
 * extension cannot do, because by then the request has already been made with
 * your credentials.
 *
 * It should accept the same JSON body the Gemini generateContent endpoint
 * accepts and return the same response, so nothing else in this codebase has to
 * know which of the two is in use.
 *
 * ⚠️ VERIFY: this is a DESIGN. No proxy has been built or tested against it.
 */
declare const __TRA_GEMINI_PROXY__: string;
export const GEMINI_PROXY_ENDPOINT: string =
  typeof __TRA_GEMINI_PROXY__ === "string" ? __TRA_GEMINI_PROXY__ : "";
