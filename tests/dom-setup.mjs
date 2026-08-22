// =============================================================================
// tests/dom-setup.mjs
// Installs a jsdom window as the globals the capture code expects.
//
// The capture modules are written against a real browser, so testing them means
// giving them a DOM. jsdom is a test-only dependency; nothing in the shipped
// extension imports it.
// =============================================================================

import { JSDOM } from "jsdom";

/**
 * Builds a DOM from an HTML string and installs it as the global environment.
 * Returns the window so a test can reach into it directly.
 */
export function installDom(html) {
  const dom = new JSDOM(html, {
    url: "https://staging.example.sa/services",
    pretendToBeVisual: true,
  });

  const { window } = dom;

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Node = window.Node;
  globalThis.Element = window.Element;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLInputElement = window.HTMLInputElement;
  globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
  globalThis.HTMLSelectElement = window.HTMLSelectElement;
  globalThis.HTMLButtonElement = window.HTMLButtonElement;
  globalThis.HTMLLabelElement = window.HTMLLabelElement;
  globalThis.ShadowRoot = window.ShadowRoot;
  globalThis.Attr = window.Attr;
  globalThis.DOMRect = window.DOMRect;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.CSS = window.CSS;
  globalThis.Document = window.Document;
  globalThis.NodeFilter = window.NodeFilter;
  globalThis.TreeWalker = window.TreeWalker;

  return window;
}
