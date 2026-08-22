// =============================================================================
// src/background/service-worker.ts
// Entry point. Wires up every listener and nothing else.
//
// Everything here must be registered SYNCHRONOUSLY at the top level. An MV3
// service worker is restarted on demand, and a listener registered inside an
// async callback may not exist yet when the event that needed it fires.
// =============================================================================

import {
  installMessageRouter,
  broadcastStatus,
  reconcileStuckSessions,
  runRetentionCleanup,
  handleToggleRecordingCommand,
} from "./message-router";
import { installNavigationListeners } from "./navigation-listener";
import { installNetworkListeners } from "./network-listener";
import { logInfo, logWarning } from "../shared/logger";
import { syncRegisteredContentScripts } from "./content-script-registration";

/**
 * Opens the side panel ourselves when the toolbar icon is clicked.
 *
 * WHY NOT setPanelBehavior({ openPanelOnActionClick: true }), which is the
 * shorter way to do this: when Chrome opens the panel for us it SWALLOWS the
 * click, so chrome.action.onClicked never fires and the extension is never
 * recorded as having been "invoked" on that tab.
 *
 * That matters more than it sounds. chrome.tabCapture refuses to hand out a
 * stream unless the extension has been invoked on the tab (the activeTab rule),
 * and host permissions do not satisfy it. Handling the click here opens the
 * panel AND registers the invocation, so pressing Record immediately afterwards
 * can actually capture video.
 *
 * The grant is revoked when the tab navigates, which is why a failed capture is
 * handled as a warning and the session records everything else regardless.
 *
 * The side panel is used rather than a popup because a popup closes the instant
 * the tester clicks back into the page - which is every single interaction they
 * are trying to record.
 */
function configureSidePanel(): void {
  if (chrome.sidePanel === undefined) {
    logWarning("worker", "chrome.sidePanel is unavailable in this browser.");
    return;
  }

  // Belt and braces: make sure Chrome is NOT opening the panel for us, or the
  // click below never arrives.
  const sidePanelApi = chrome.sidePanel as unknown as {
    setPanelBehavior?: (options: { openPanelOnActionClick: boolean }) => Promise<void>;
    open?: (options: { tabId?: number; windowId?: number }) => Promise<void>;
  };

  if (typeof sidePanelApi.setPanelBehavior === "function") {
    sidePanelApi
      .setPanelBehavior({ openPanelOnActionClick: false })
      .catch(function onBehaviorError(behaviorError: unknown): void {
        logWarning("worker", "Could not set the panel behaviour.", behaviorError);
      });
  }

  chrome.action.onClicked.addListener(function onActionClicked(
    tab: chrome.tabs.Tab,
  ): void {
    logInfo("worker", "Extension invoked on tab " + String(tab.id) + ".");

    if (typeof sidePanelApi.open !== "function") {
      logWarning("worker", "chrome.sidePanel.open is unavailable.");
      return;
    }

    // Must be called synchronously in the click handler: it needs the user
    // gesture that the click provides.
    const openOptions: { tabId?: number; windowId?: number } = {};
    if (tab.id !== undefined) {
      openOptions.tabId = tab.id;
    } else if (tab.windowId !== undefined) {
      openOptions.windowId = tab.windowId;
    }

    sidePanelApi.open(openOptions).catch(function onOpenError(openError: unknown): void {
      logWarning("worker", "Could not open the side panel.", openError);
    });
  });
}

/**
 * Registers the keyboard shortcut that starts and stops recording.
 *
 * WHY this exists, beyond convenience: Chrome grants activeTab when the user
 * INVOKES the extension, and a registered keyboard command counts as an
 * invocation. tabCapture requires that grant and host permissions do not
 * satisfy it, so the shortcut is the most reliable way for a tester to arm
 * video capture on the page they are already looking at - no hunting for the
 * toolbar icon, and no navigation in between to revoke the grant.
 */
function installKeyboardCommands(): void {
  if (chrome.commands === undefined) {
    logWarning("worker", "chrome.commands is unavailable in this browser.");
    return;
  }

  chrome.commands.onCommand.addListener(function onCommand(
    command: string,
    tab?: chrome.tabs.Tab,
  ): void {
    if (command !== "toggle-recording") {
      return;
    }
    logInfo("worker", "Extension invoked by keyboard shortcut.");
    void handleToggleRecordingCommand(tab);
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
  installKeyboardCommands();

  chrome.runtime.onInstalled.addListener(function onInstalled(): void {
    logInfo("worker", "Extension installed or updated.");
    void syncRegisteredContentScripts();
    void reconcileStuckSessions()
      .then(runRetentionCleanup)
      .then(broadcastStatus);
  });

  chrome.runtime.onStartup.addListener(function onStartup(): void {
    logInfo("worker", "Browser started.");
    void syncRegisteredContentScripts();
    void reconcileStuckSessions()
      .then(runRetentionCleanup)
      .then(broadcastStatus);
  });

  // The content scripts follow the grants. A tester who grants their staging
  // origin from the options page should be recording on it a second later,
  // without restarting the browser; a tester who revokes it should stop being
  // watched immediately.
  chrome.permissions.onAdded.addListener(function onPermissionAdded(): void {
    logInfo("worker", "A permission was granted; re-registering content scripts.");
    void syncRegisteredContentScripts();
  });

  chrome.permissions.onRemoved.addListener(function onPermissionRemoved(): void {
    logInfo("worker", "A permission was revoked; re-registering content scripts.");
    void syncRegisteredContentScripts();
  });

  // Also on plain worker start. onInstalled and onStartup do not fire when the
  // worker is merely woken from idle, and a registration lost to any cause
  // would otherwise stay lost until the next browser restart.
  void syncRegisteredContentScripts();

  logInfo("worker", "Service worker initialised.");
}

initialiseServiceWorker();
