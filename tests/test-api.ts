// =============================================================================
// tests/test-api.ts
// A single entry point that re-exports everything under test, so the test
// bundle is one file and the tests import from one place.
//
// WHY a bundle instead of running TypeScript directly: the source is ESM
// TypeScript with cross-directory imports, and bundling it once with the same
// esbuild the extension uses means the tests exercise exactly the code that
// ships, not a differently-transpiled copy of it.
// =============================================================================

export { pruneDomForAI, DEFAULT_PRUNE_OPTIONS, pruneElementSubtree }
  from "../src/capture/prune-dom";
export { getElementSelector, isInsideRepeatedList, looksLikeGeneratedIdentifier }
  from "../src/capture/selector";
export { getAriaRole, getAccessibleName, getVisibleText, getAssociatedLabelText }
  from "../src/capture/accessible-name";
export { captureElementContext } from "../src/capture/element-context";
export { isElementHidden, isElementInteractive, resolveInteractiveTarget }
  from "../src/capture/visibility";

export {
  redactSensitiveData,
  redactValuePatterns,
  redactUrl,
  redactHtml,
  redactPlaywrightScript,
  compileCustomPatterns,
} from "../src/ai/redact";
export {
  validateBugReport,
  reconcileEvidenceUsed,
  normaliseExpectedBehavior,
  isNotDeterminableSentence,
} from "../src/ai/validate";
export { generateBugReport, resolveModelId, uploadVideoToFilesApi, deleteUploadedFile }
  from "../src/ai/gemini";
export { formatReportAsPlainText, formatReportWithMetadata } from "../src/ai/format";
export { BUG_REPORT_RESPONSE_SCHEMA, schemaPropertyNames } from "../src/ai/schema";
export {
  selectSnapshotsForBundle,
  selectElementContextsForBundle,
  truncateActionTrace,
  enforceSnapshotCharacterBudget,
  detectEnvironment,
  estimateInputTokens,
  findFailureEventIndexes,
  describeElementForModel,
  describeRequestCost,
  requestNeedsCostConfirmation,
} from "../src/ai/bundle";
export { chooseKeyFrameOffsets, isVideoMimeTypeSupported, extractBase64Payload }
  from "../src/ai/video";
export { SYSTEM_INSTRUCTION, buildEvidenceText, buildLanguageInstruction }
  from "../src/ai/prompt";

export { generatePlaywrightSpec, buildSpecFileName, describeBrowserLevelShortcut,
  describeKeystrokeCorrections, describeMousePath }
  from "../src/codegen/generate-spec";
export { coalesceEventsForCodegen, nextEventAfter }
  from "../src/codegen/coalesce-events";
export {
  locatorToPlaywrightExpression,
  buildLocatorComments,
  quote,
  escapeForSingleQuotedString,
  makePathRelativeToRow,
} from "../src/codegen/locator-to-playwright";
export { buildClosingAssertions, findFailureAfterEvent }
  from "../src/codegen/assertions";

export { applyRetentionPolicy } from "../src/storage/sessions";
export {
  formatVideoTimestamp,
  formatDuration,
  formatBytes,
  wallClockToVideoOffsetMs,
} from "../src/shared/time";
export { createId } from "../src/shared/ids";
export { NOT_DETERMINABLE_SENTENCE, SUPPORTED_MODELS, MAX_SNAPSHOT_CHARACTERS }
  from "../src/shared/constants";

export { normaliseSession } from "../src/storage/sessions";
export { normaliseEvent } from "../src/storage/events";
