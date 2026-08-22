// =============================================================================
// src/content/page-world.ts
// Runs in the PAGE's own JavaScript realm at document_start.
//
// It has NO access to chrome.* APIs, so it reports across the postMessage
// bridge. Every patch is TRANSPARENT: it always calls through to the original,
// never changes a return value, and never swallows an error.
// =============================================================================

import { postToBridge } from "./bridge";
import {
  MAX_BODY_EXCERPT_CHARACTERS,
  MAX_STACK_EXCERPT_CHARACTERS,
} from "../shared/constants";

/**
 * Cuts a long string down to a fixed budget and marks that it was cut.
 * WHY: response bodies can be megabytes; we only need enough to recognise an
 * error message.
 */
function truncateText(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) {
    return text;
  }
  return text.slice(0, maxCharacters) + "\n…[truncated]";
}

/**
 * Turns any console argument into a readable string without ever throwing.
 */
function stringifyArgument(argument: unknown): string {
  if (typeof argument === "string") {
    return argument;
  }
  if (argument instanceof Error) {
    return argument.name + ": " + argument.message;
  }
  if (argument === null) {
    return "null";
  }
  if (argument === undefined) {
    return "undefined";
  }
  try {
    return JSON.stringify(argument);
  } catch (serialisationError: unknown) {
    return String(argument);
  }
}

/**
 * Extracts the method and URL from the many shapes fetch() accepts.
 */
function describeFetchRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): { method: string; url: string } {
  let url: string = "";
  let method: string = "GET";

  if (typeof input === "string") {
    url = input;
  } else if (input instanceof URL) {
    url = input.href;
  } else {
    url = input.url;
    method = input.method;
  }

  if (init !== undefined && typeof init.method === "string") {
    method = init.method;
  }

  return { method: method.toUpperCase(), url: url };
}

/**
 * Reads a request body only when it is a plain string.
 * WHY we do not read FormData or Blob bodies: consuming them would break the
 * application's own request. File uploads are therefore invisible to us, and
 * that limitation is documented rather than worked around.
 */
function describeRequestBody(init: RequestInit | undefined): string {
  if (init === undefined || init.body === undefined || init.body === null) {
    return "";
  }
  if (typeof init.body === "string") {
    return truncateText(init.body, MAX_BODY_EXCERPT_CHARACTERS);
  }
  return "[non-text body]";
}

/**
 * Replaces window.fetch with a wrapper that reports method, URL, status and a
 * body excerpt, then returns the original response untouched.
 *
 * WHY we clone the response: reading the body consumes the stream, and the
 * application must still be able to read it.
 */
function patchFetch(): void {
  const originalFetch: typeof window.fetch = window.fetch;
  if (typeof originalFetch !== "function") {
    return;
  }

  window.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const startedAtMs: number = Date.now();
    const described = describeFetchRequest(input, init);
    const requestBodyExcerpt: string = describeRequestBody(init);

    try {
      const response: Response = await originalFetch.call(window, input, init);

      // Read the body from a CLONE, without awaiting it here.
      //
      // Awaiting the clone before returning would hold the application's own
      // response until the entire body had been buffered - turning a streamed
      // response into a buffered one, delaying every request the page makes,
      // and breaking server-sent events outright. A QA tool that changes the
      // timing of the thing it is measuring is worse than useless.
      let clonedResponse: Response | null = null;
      try {
        clonedResponse = response.clone();
      } catch (cloneError: unknown) {
        clonedResponse = null;   // Body already consumed, or opaque.
      }

      const reportWithBody = function reportWithBody(bodyText: string): void {
        postToBridge("network", {
          method: described.method,
          url: described.url,
          statusCode: response.status,
          statusText: response.statusText,
          startedAtMs: startedAtMs,
          durationMs: Date.now() - startedAtMs,
          requestBodyExcerpt: requestBodyExcerpt,
          responseBodyExcerpt: truncateText(bodyText, MAX_BODY_EXCERPT_CHARACTERS),
          responseContentType: response.headers.get("content-type") ?? "",
          pageUrl: window.location.href,
        });
      };

      if (clonedResponse === null) {
        reportWithBody("");
      } else {
        void clonedResponse.text().then(reportWithBody, function onBodyError(): void {
          reportWithBody("");
        });
      }

      return response;
    } catch (networkError: unknown) {
      postToBridge("network", {
        method: described.method,
        url: described.url,
        statusCode: 0,
        statusText: stringifyArgument(networkError),
        startedAtMs: startedAtMs,
        durationMs: Date.now() - startedAtMs,
        requestBodyExcerpt: requestBodyExcerpt,
        responseBodyExcerpt: "",
        responseContentType: "",
        pageUrl: window.location.href,
      });
      throw networkError;   // The page must still see its own error.
    }
  };
}

/** Per-request bookkeeping attached to a patched XMLHttpRequest. */
interface XhrRecord {
  method: string;
  url: string;
  startedAtMs: number;
  requestBodyExcerpt: string;
}

/**
 * Patches XMLHttpRequest.
 * WHY it is not optional: many older enterprise applications, which is exactly
 * what this extension is aimed at, still use XHR exclusively.
 */
function patchXmlHttpRequest(): void {
  const OriginalXhr: typeof XMLHttpRequest = window.XMLHttpRequest;
  if (typeof OriginalXhr !== "function") {
    return;
  }

  const recordByInstance: WeakMap<XMLHttpRequest, XhrRecord> =
    new WeakMap<XMLHttpRequest, XhrRecord>();

  /** Instances that already have a loadend listener attached. */
  const listeningInstances: WeakSet<XMLHttpRequest> = new WeakSet<XMLHttpRequest>();

  const originalOpen = OriginalXhr.prototype.open;
  const originalSend = OriginalXhr.prototype.send;

  OriginalXhr.prototype.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
  ): void {
    recordByInstance.set(this, {
      method: String(method).toUpperCase(),
      url: typeof url === "string" ? url : url.href,
      startedAtMs: 0,
      requestBodyExcerpt: "",
    });
    // eslint-disable-next-line prefer-rest-params
    return originalOpen.apply(this, arguments as unknown as Parameters<typeof originalOpen>);
  } as typeof originalOpen;

  OriginalXhr.prototype.send = function patchedSend(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const record: XhrRecord | undefined = recordByInstance.get(this);
    if (record !== undefined) {
      record.startedAtMs = Date.now();
      if (typeof body === "string") {
        record.requestBodyExcerpt = truncateText(body, MAX_BODY_EXCERPT_CHARACTERS);
      } else if (body !== undefined && body !== null) {
        record.requestBodyExcerpt = "[non-text body]";
      }

      // Attach the listener ONCE per instance. An application that reuses one
      // XMLHttpRequest object for several requests - which is legal and still
      // common - would otherwise accumulate a listener per send() and report
      // the same response two, three, four times.
      const alreadyListening = listeningInstances.has(this);
      if (alreadyListening) {
        return originalSend.apply(this, arguments as unknown as Parameters<typeof originalSend>);
      }
      listeningInstances.add(this);

      this.addEventListener("loadend", function onLoadEnd(this: XMLHttpRequest): void {
        let responseBodyExcerpt: string = "";
        try {
          if (this.responseType === "" || this.responseType === "text") {
            responseBodyExcerpt =
              truncateText(String(this.responseText), MAX_BODY_EXCERPT_CHARACTERS);
          }
        } catch (readError: unknown) {
          responseBodyExcerpt = "";
        }

        postToBridge("network", {
          method: record.method,
          url: record.url,
          statusCode: this.status,
          statusText: this.statusText,
          startedAtMs: record.startedAtMs,
          durationMs: Date.now() - record.startedAtMs,
          requestBodyExcerpt: record.requestBodyExcerpt,
          responseBodyExcerpt: responseBodyExcerpt,
          responseContentType: this.getResponseHeader("content-type") ?? "",
          pageUrl: window.location.href,
        });
      });
    }
    // eslint-disable-next-line prefer-rest-params
    return originalSend.apply(this, arguments as unknown as Parameters<typeof originalSend>);
  } as typeof originalSend;
}

/**
 * Reports console.error and console.warn calls without swallowing them.
 */
function patchConsole(): void {
  const originalError = console.error;
  const originalWarn = console.warn;

  console.error = function patchedError(...args: unknown[]): void {
    let stackExcerpt: string = "";
    try {
      stackExcerpt = truncateText(new Error().stack ?? "", MAX_STACK_EXCERPT_CHARACTERS);
    } catch (stackError: unknown) {
      stackExcerpt = "";
    }

    const parts: string[] = [];
    for (let index = 0; index < args.length; index = index + 1) {
      parts.push(stringifyArgument(args[index]));
    }

    postToBridge("console", {
      level: "error",
      message: truncateText(parts.join(" "), MAX_BODY_EXCERPT_CHARACTERS),
      stackExcerpt: stackExcerpt,
      wallClockMs: Date.now(),
      pageUrl: window.location.href,
    });

    originalError.apply(console, args);
  };

  console.warn = function patchedWarn(...args: unknown[]): void {
    const parts: string[] = [];
    for (let index = 0; index < args.length; index = index + 1) {
      parts.push(stringifyArgument(args[index]));
    }

    postToBridge("console", {
      level: "warning",
      message: truncateText(parts.join(" "), MAX_BODY_EXCERPT_CHARACTERS),
      stackExcerpt: "",
      wallClockMs: Date.now(),
      pageUrl: window.location.href,
    });

    originalWarn.apply(console, args);
  };
}

/**
 * Reports uncaught errors and unhandled promise rejections.
 */
function installGlobalErrorListeners(): void {
  window.addEventListener("error", function onGlobalError(event: ErrorEvent): void {
    let stackExcerpt: string = "";
    if (event.error instanceof Error) {
      stackExcerpt = truncateText(event.error.stack ?? "", MAX_STACK_EXCERPT_CHARACTERS);
    }
    postToBridge("console", {
      level: "error",
      message: truncateText(event.message, MAX_BODY_EXCERPT_CHARACTERS),
      stackExcerpt: stackExcerpt,
      wallClockMs: Date.now(),
      pageUrl: window.location.href,
    });
  });

  window.addEventListener(
    "unhandledrejection",
    function onRejection(event: PromiseRejectionEvent): void {
      let stackExcerpt: string = "";
      if (event.reason instanceof Error) {
        stackExcerpt =
          truncateText(event.reason.stack ?? "", MAX_STACK_EXCERPT_CHARACTERS);
      }
      postToBridge("console", {
        level: "unhandled-rejection",
        message: truncateText(
          stringifyArgument(event.reason),
          MAX_BODY_EXCERPT_CHARACTERS,
        ),
        stackExcerpt: stackExcerpt,
        wallClockMs: Date.now(),
        pageUrl: window.location.href,
      });
    },
  );
}

/**
 * Reports SPA route changes.
 *
 * WHY it lives here and not in the isolated world: history.pushState is a
 * function on the page's own History object, so only a MAIN-world script can
 * see it being called. Without this, a single-page application looks like one
 * long page with no navigation at all.
 */
function patchHistoryApi(): void {
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  function reportUrlChange(changeKind: string): void {
    postToBridge("url-change", {
      changeKind: changeKind,
      pageUrl: window.location.href,
      pageTitle: document.title,
      wallClockMs: Date.now(),
    });
  }

  history.pushState = function patchedPushState(
    this: History,
    ...args: Parameters<typeof originalPushState>
  ): void {
    const result = originalPushState.apply(this, args);
    reportUrlChange("pushState");
    return result;
  };

  history.replaceState = function patchedReplaceState(
    this: History,
    ...args: Parameters<typeof originalReplaceState>
  ): void {
    const result = originalReplaceState.apply(this, args);
    reportUrlChange("replaceState");
    return result;
  };

  window.addEventListener("popstate", function onPopState(): void {
    reportUrlChange("popstate");
  });

  window.addEventListener("hashchange", function onHashChange(): void {
    reportUrlChange("hashchange");
  });
}

/**
 * Installs every patch exactly once, even if the script is injected twice.
 */
function initialisePageWorld(): void {
  const marker = "__testerReporterAiPageWorldInstalled";
  const globalWindow = window as unknown as Record<string, unknown>;
  if (globalWindow[marker] === true) {
    return;
  }
  globalWindow[marker] = true;

  patchFetch();
  patchXmlHttpRequest();
  patchConsole();
  installGlobalErrorListeners();
  patchHistoryApi();
}

initialisePageWorld();
