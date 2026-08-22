// =============================================================================
// src/shared/types.ts
// Every interface that crosses a context boundary or is persisted lives here.
// One file, so a junior developer never has to hunt for a type definition.
// =============================================================================

// -----------------------------------------------------------------------------
// Element identification
// -----------------------------------------------------------------------------

/**
 * The named strategies we use to find an element again, in priority order.
 * WHY: the codegen and the AI both need to know HOW confident we are in a
 * locator, not just what the locator string is.
 */
export type LocatorStrategy =
  | "test-id"
  | "role-and-name"
  | "label"
  | "placeholder"
  | "alt-text"
  | "title"
  | "exact-text"
  | "css-path"
  | "xpath";

/**
 * One candidate way of finding the element. We always store several.
 * WHY: if the primary one turns out to be non-unique at replay time, the
 * junior tester has a written list of alternatives right there in the spec.
 */
export interface LocatorCandidate {
  strategy: LocatorStrategy;
  /** The raw value: the test-id selector, the accessible name, the CSS path. */
  value: string;
  /** For "role-and-name" only: the ARIA role. Empty string otherwise. */
  role: string;
  /** How many elements matched this candidate at capture time. 1 is what we want. */
  matchCount: number;
  /** True when matchCount === 1 at capture time. */
  isUniqueAtCaptureTime: boolean;
}

/**
 * One step in the chain of iframes leading to the element.
 * WHY: Playwright needs frameLocator() calls in the same order.
 */
export interface FrameStep {
  /** Chrome's frame id, useful for correlating with webNavigation events. */
  frameId: number;
  /** A CSS selector that finds this <iframe> inside its PARENT document. */
  frameSelector: string;
  /** The frame's URL at capture time, for the human reading the spec. */
  frameUrl: string;
}

/** The complete "how do I find this element again" record. */
export interface ElementLocator {
  strategy: LocatorStrategy;
  primary: LocatorCandidate;
  /** Every other candidate we managed to build, best first. */
  fallbacks: LocatorCandidate[];
  /** Empty array when the element is in the top-level document. */
  framePath: FrameStep[];
  /** True when the element lives inside one or more open shadow roots. */
  isInShadowDom: boolean;
  /**
   * True when the element is the host of a CLOSED shadow root, which Playwright
   * cannot reach into. The generated spec carries a warning comment.
   */
  isClosedShadowHost: boolean;
  /** CSS selectors for each shadow host, outermost first. */
  shadowHostSelectors: string[];
  /** True when the element sits inside a repeated list or table. */
  isInsideRepeatedList: boolean;
  /**
   * When the element is inside a repeated list AND the row carries unique text,
   * this holds that text so codegen can write a .filter({ hasText }) locator.
   */
  listRowAnchorText: string;
  /** The ARIA role of the repeated row container, e.g. "row" or "listitem". */
  listRowRole: string;
  tagName: string;
  ariaRole: string;
  visibleText: string;
  accessibleName: string;
}

// -----------------------------------------------------------------------------
// Recorded interaction events
// -----------------------------------------------------------------------------

/**
 * Every kind of thing we record. Keep this list closed: codegen switches on it
 * exhaustively, so adding a member forces you to handle it everywhere.
 */
export type RecordedEventType =
  | "session-start"
  | "navigate"
  | "url-change"
  | "reload"
  | "tab-activated"
  | "click"
  | "dblclick"
  | "input"
  | "select-option"
  | "check"
  | "uncheck"
  | "press-key"
  | "hover"
  | "scroll"
  | "tester-note"
  | "session-stop";

/**
 * One recorded user action.
 * WHY two clocks: wallClockMs is real time; videoOffsetMs is the position in
 * the RECORDED MEDIA, which is shorter than real time because pauses are not
 * recorded. The AI is given videoOffsetMs so it can look at the right frame.
 */
export interface RecordedEvent {
  /** Monotonic within a session, starting at 0. Also the ordering key. */
  index: number;
  sessionId: string;
  type: RecordedEventType;
  wallClockMs: number;
  /** Position inside the recorded video, in milliseconds. -1 if unknown. */
  videoOffsetMs: number;
  pageUrl: string;
  pageTitle: string;
  tabId: number;
  /** Chrome frame id; 0 for the top-level frame. */
  frameId: number;
  /** null for events with no element (navigate, reload, tab-activated). */
  locator: ElementLocator | null;
  /**
   * For "input": the FINAL value of the field, already redacted if sensitive.
   * For "select-option": the chosen option value.
   * For "press-key": the key name, e.g. "Enter".
   * For "scroll": "x,y" as a string.
   */
  value: string;
  /** True when `value` was replaced by a redaction marker. */
  valueWasRedacted: boolean;
  clientX: number;
  clientY: number;
  /** Id of the DomSnapshot taken at this moment, or "" if none was taken. */
  domSnapshotId: string;
  /** Id of the ElementContext captured for this event, or "" if none. */
  elementContextId: string;
}

// -----------------------------------------------------------------------------
// Page code capture
// -----------------------------------------------------------------------------

/** Why we decided this moment was worth a full-page snapshot. */
export type SnapshotTrigger =
  | "first-load"
  | "navigation"
  | "url-change"
  | "interaction"
  | "console-error"
  | "network-failure"
  | "session-stop";

/** A pruned whole-page HTML snapshot. */
export interface DomSnapshot {
  id: string;
  sessionId: string;
  /** The index of the RecordedEvent this snapshot belongs to, or -1. */
  eventIndex: number;
  trigger: SnapshotTrigger;
  wallClockMs: number;
  videoOffsetMs: number;
  pageUrl: string;
  pageTitle: string;
  documentLang: string;
  /** "ltr", "rtl" or "". */
  documentDir: string;
  viewportWidth: number;
  viewportHeight: number;
  prunedHtml: string;
  characterCount: number;
  wasTruncated: boolean;
  droppedElementCount: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AriaState {
  role: string;
  ariaLabel: string;
  /** Resolved TEXT of the described-by target, not the id. */
  ariaDescribedByText: string;
  ariaExpanded: string;
  ariaInvalid: string;
  ariaDisabled: string;
  ariaChecked: string;
  ariaSelected: string;
  ariaHidden: string;
  isNativelyDisabled: boolean;
  isReadOnly: boolean;
  isRequired: boolean;
  /** HTMLInputElement.validationMessage, or "" for non-form elements. */
  validationMessage: string;
}

/** The bounded structural context around one interacted element. */
export interface ElementContext {
  id: string;
  sessionId: string;
  eventIndex: number;
  elementHtml: string;
  ancestorHtml: string;
  ancestorDepth: number;
  /** Pruned outerHTML of up to 3 previous and 3 next siblings, in order. */
  siblingHtml: string[];
  computedStyles: Record<string, string>;
  ariaState: AriaState;
  inheritedLang: string;
  inheritedDir: string;
  boundingBox: BoundingBox;
}

// -----------------------------------------------------------------------------
// Network and console
// -----------------------------------------------------------------------------

/** Which mechanism produced this entry. Both may see the same request. */
export type NetworkSource = "page-world-patch" | "web-request-api";

export interface NetworkEntry {
  id: string;
  sessionId: string;
  source: NetworkSource;
  method: string;
  url: string;
  /** 0 when the request failed before a response (DNS failure, CORS block). */
  statusCode: number;
  statusText: string;
  startedAtMs: number;
  /** Milliseconds from start to response end. -1 if unknown. */
  durationMs: number;
  videoOffsetMs: number;
  /** Truncated request body, already redacted. "" when not captured. */
  requestBodyExcerpt: string;
  /** Truncated response body, already redacted. "" when not captured. */
  responseBodyExcerpt: string;
  /** Allow-listed request headers only; Authorization/Cookie are never stored. */
  requestHeaders: Record<string, string>;
  responseContentType: string;
  /** True for status >= 400 or statusCode === 0. Likely bug evidence. */
  isFailure: boolean;
  initiatorPageUrl: string;
}

export type ConsoleLevel = "error" | "warning" | "unhandled-rejection";

export interface ConsoleEntry {
  id: string;
  sessionId: string;
  level: ConsoleLevel;
  message: string;
  stackExcerpt: string;
  wallClockMs: number;
  videoOffsetMs: number;
  pageUrl: string;
}

// -----------------------------------------------------------------------------
// Media
// -----------------------------------------------------------------------------

export type MediaState =
  | "not-started"
  | "recording"
  | "paused"
  | "stopped"
  | "failed";

export interface MediaRecordInfo {
  /** IndexedDB key of the stored Blob. "" until the recording is finished. */
  mediaId: string;
  /** e.g. "video/webm;codecs=vp9,opus" — whatever MediaRecorder actually used. */
  mimeType: string;
  sizeBytes: number;
  /** Duration of the RECORDED media (pauses excluded), in milliseconds. */
  durationMs: number;
  videoWidth: number;
  videoHeight: number;
  frameRate: number;
  hasMicrophoneAudio: boolean;
  hasTabAudio: boolean;
  state: MediaState;
  failureReason: string;
}

// -----------------------------------------------------------------------------
// Session
// -----------------------------------------------------------------------------

export type SessionStatus =
  | "recording"
  | "paused"
  /** Stopped; generating spec + bundle. */
  | "processing"
  /** Artifacts exist; report may or may not exist yet. */
  | "ready"
  /** Artifacts exist, the AI step failed. NEVER blocks the artifacts. */
  | "report-failed"
  | "complete";

export type ReportLanguage = "en" | "ar";

export interface RecordingSession {
  id: string;
  name: string;
  status: SessionStatus;
  startedAtMs: number;
  /** 0 while still recording. */
  stoppedAtMs: number;
  /** Total real elapsed time including pauses. */
  wallClockDurationMs: number;
  /** Recorded media time, excluding pauses. */
  recordedDurationMs: number;
  originTabId: number;
  originUrl: string;
  originTitle: string;
  /** Every distinct URL visited during the session, in order. */
  visitedUrls: string[];
  eventCount: number;
  domSnapshotCount: number;
  networkEntryCount: number;
  networkFailureCount: number;
  consoleErrorCount: number;
  media: MediaRecordInfo;
  /** The generated Playwright source. "" until codegen has run. */
  playwrightScript: string;
  /** The validated report, or null if not generated / failed. */
  bugReport: GeneratedBugReport | null;
  /** The tester's edited plain-text version. "" until they edit it. */
  editedReportText: string;
  reportLanguage: ReportLanguage;
  /** Set when the AI step failed, so the review page can explain why. */
  reportFailureReason: string;
  /** True once the tester consented to uploading video for this session. */
  videoUploadConsentGiven: boolean;
  /** Counts by redaction category, shown so the tester can trust the gate. */
  redactionSummary: Record<string, number>;
  /** How the video was delivered on the last AI attempt. */
  lastVideoDeliveryMode: VideoDeliveryMode;
  /** Human-readable note about any video downgrade. */
  videoDowngradeReason: string;
}

// -----------------------------------------------------------------------------
// The AI evidence bundle
// -----------------------------------------------------------------------------

/** One human-readable step in the trace we hand to the model. */
export interface ActionTraceStep {
  stepNumber: number;
  actionType: RecordedEventType;
  /** e.g. '"Contract Renewal & Continuation" (role=tab)'. */
  elementDescription: string;
  /** Already redacted. "" when the action had no value. */
  inputValue: string;
  wasRedacted: boolean;
  pageUrl: string;
  wallClockMs: number;
  /** Where to look in the video, formatted "MM:SS". */
  videoTimestamp: string;
  videoOffsetMs: number;
}

export interface BundledDomSnapshot {
  snapshotId: string;
  trigger: SnapshotTrigger;
  /** Plain-English reason this moment mattered, written by the extension. */
  significanceReason: string;
  videoTimestamp: string;
  pageUrl: string;
  documentLang: string;
  documentDir: string;
  prunedHtml: string;
  wasTruncated: boolean;
}

export interface BundledElementContext {
  stepNumber: number;
  elementDescription: string;
  videoTimestamp: string;
  elementHtml: string;
  ancestorHtml: string;
  siblingHtml: string[];
  computedStyles: Record<string, string>;
  ariaState: AriaState;
  inheritedLang: string;
  inheritedDir: string;
}

/** How the video is being delivered to the model on this particular request. */
export type VideoDeliveryMode =
  | "files-api-uri"
  | "inline-base64"
  | "key-frames"
  | "omitted";

export interface BundledVideo {
  deliveryMode: VideoDeliveryMode;
  /** Set for "files-api-uri". */
  fileUri: string;
  /** Set for "inline-base64". */
  base64Data: string;
  /** Set for "key-frames": base64 JPEG payloads without the data: prefix. */
  keyFrameBase64: string[];
  keyFrameOffsetsMs: number[];
  mimeType: string;
  durationMs: number;
  sizeBytes: number;
  /** Plain-English note explaining any downgrade, shown to the tester too. */
  downgradeReason: string;
}

export interface PageMeta {
  title: string;
  url: string;
  documentLang: string;
  documentDir: string;
  viewportWidth: number;
  viewportHeight: number;
  /** "staging" | "production" | "local" | "development" | "unknown". */
  detectedEnvironment: string;
  userAgent: string;
}

/**
 * Everything the model is given. Nothing outside this object reaches Gemini.
 * WHY one flat object: it is the single thing redaction has to clean, and the
 * single thing the review page shows back to the tester.
 */
export interface AIEvidenceBundle {
  sessionId: string;
  reportLanguage: ReportLanguage;
  actionTrace: ActionTraceStep[];
  playwrightScript: string;
  domSnapshots: BundledDomSnapshot[];
  elementContext: BundledElementContext[];
  networkFailures: NetworkEntry[];
  consoleErrors: ConsoleEntry[];
  video: BundledVideo;
  pageMeta: PageMeta;
  /** True once redactSensitiveData() has run successfully. Gate flag. */
  redactionCompleted: boolean;
  redactionSummary: Record<string, number>;
  /** Set when truncation dropped steps, so the model knows about the gap. */
  truncationNotes: string[];
  /** Rough token estimate computed locally before sending. */
  estimatedInputTokens: number;
}

// -----------------------------------------------------------------------------
// The model's output
// -----------------------------------------------------------------------------

export type SeverityGuess = "blocker" | "major" | "minor" | "cosmetic";

export type DefectType =
  | "ui"
  | "functional"
  | "api"
  | "content"
  | "performance"
  | "unknown";

export type ReportConfidence = "high" | "medium" | "low";

export interface EvidenceUsed {
  video: boolean;
  playwrightScript: boolean;
  pageCode: boolean;
  networkOrConsole: boolean;
}

export interface GeneratedBugReport {
  title: string;
  description: string;
  precondition: string;
  stepsToReproduce: string[];
  currentBehavior: string;
  expectedBehavior: string;
  expectedBehaviorDeterminable: boolean;
  severityGuess: SeverityGuess;
  defectType: DefectType;
  evidenceUsed: EvidenceUsed;
  /** e.g. "console error at 00:42", "GET /api/x -> 500". */
  supportingEvidence: string[];
  /** Anything inferred rather than directly observed. */
  unverifiedClaims: string[];
  /** Other defects noticed but not reported as primary. */
  secondaryIssues: string[];
  confidence: ReportConfidence;
}

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------

export interface ExtensionSettings {
  geminiApiKey: string;
  modelId: string;
  reportLanguage: ReportLanguage;
  captureMicrophone: boolean;
  /**
   * Also capture the tab's own audio. On by default.
   *
   * There is exactly ONE tabCapture attempt per tab, so if a machine cannot
   * capture tab audio the whole request fails and the video is lost. That is
   * rare - it was originally observed only because a test flag was breaking
   * capture entirely - but the escape hatch is worth keeping for anyone it
   * happens to. Turning it off costs application sounds and nothing else: the
   * tester's narration is a separate microphone stream.
   */
  captureTabAudio: boolean;
  /** Global switch: when true the video is never uploaded, whatever else. */
  neverUploadVideo: boolean;
  /** Set once the tester has accepted the video-upload warning. */
  videoUploadConsentGiven: boolean;
  /** Extra user-supplied redaction patterns, as regex source strings. */
  customRedactionPatterns: string[];
  /** 0 means "never delete automatically". */
  retentionDays: number;
  /** Rolling count of API requests made, for a rough usage sanity check. */
  monthlyRequestCount: number;
  /** "YYYY-MM" of the month monthlyRequestCount refers to. */
  monthlyRequestCountMonth: string;
}
