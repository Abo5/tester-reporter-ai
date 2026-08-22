// =============================================================================
// src/background/service-worker.ts
// Entry point. Wires up every listener and nothing else.
//
// Everything here must be registered SYNCHRONOUSLY at the top level. An MV3
// service worker is restarted on demand, and a listener registered inside an
// async callback may not exist yet when the event that needed it fires.
// =============================================================================

import { installMessageRouter, broadcastStatus, reconcileStuckSessions }
  from "./message-router";
import { installNavigationListeners } from "./navigation-listener";
import { installNetworkListeners } from "./network-listener";
import { logInfo, logWarning } from "../shared/logger";

/**
 * Opens the side panel when the toolbar icon is clicked.
 *
 * VERIFY: chrome.sidePanel availability and the setPanelBehavior option name in
 * your target Chrome. The side panel is used rather than a popup because a
 * popup closes the instant the tester clicks back into the page, which is every
 * single interaction they are trying to record.
 */
function configureSidePanel(): void {
  const sidePanel = chrome.sidePanel as unknown as {
    setPanelBehavior?: (options: { openPanelOnActionClick: boolean }) => Promise<void>;
  } | undefined;

  if (sidePanel === undefined || typeof sidePanel.setPanelBehavior !== "function") {
    logWarning("worker", "chrome.sidePanel.setPanelBehavior is unavailable.");
    return;
  }

  sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(function onPanelError(panelError: unknown): void {
      logWarning("worker", "Could not configure the side panel.", panelError);
    });
}

/**
 * Registers everything. Called once, synchronously, at worker start.
 */
function initialiseServiceWorker(): void {
  installMessageRouter();
  installNavigationListeners();
  installNetworkListeners();
  configureSidePanel();

  chrome.runtime.onInstalled.addListener(function onInstalled(): void {
    logInfo("worker", "Extension installed or updated.");
    void reconcileStuckSessions().then(broadcastStatus);
  });

  chrome.runtime.onStartup.addListener(function onStartup(): void {
    logInfo("worker", "Browser started.");
    void reconcileStuckSessions().then(broadcastStatus);
  });

  logInfo("worker", "Service worker initialised.");
}

initialiseServiceWorker();
