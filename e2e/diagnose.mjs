// Diagnostic: dump exactly what a session captures, with locators.
import { launchWithExtension, callExtension, readStore, openExtensionPage, waitFor, readRecordingState } from "./harness.mjs";
import { startFixtureServer } from "./fixture-server.mjs";

const server = await startFixtureServer();
const browser = await launchWithExtension();
const extPage = await openExtensionPage(browser.context, browser.extensionId, "options/options.html");

const page = await browser.context.newPage();

// Surface content-script errors that would otherwise be invisible.
page.on("console", (m) => { if (m.type() === "error") console.log("  [page console.error]", m.text().slice(0, 160)); });
page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 160)));

await page.goto(`${server.url}/catalog.html`, { waitUntil: "load" });
await page.bringToFront();

const tabId = await browser.serviceWorker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? -1);
await callExtension(extPage, { kind: "ui/start-recording", tabId, captureMicrophone: false });
await waitFor("recording", async () => (await readRecordingState(browser.serviceWorker))?.status === "recording");
await page.bringToFront();
await page.waitForTimeout(400);

console.log("\n--- performing: click tab / fill / Enter / click view ---");
await page.click('[data-testid="tab-renewal"]');
await page.waitForTimeout(300);
await page.fill("#tenant", "TN-40192");
await page.waitForTimeout(800);          // let the input coalescer flush
await page.press("#tenant", "Enter");
await page.waitForTimeout(1500);
await page.click("tbody tr:nth-child(3) .view");
await page.waitForTimeout(800);

await callExtension(extPage, { kind: "ui/stop-recording" });
await waitFor("done", async () => {
  const s = (await readStore(extPage, "sessions"))[0];
  return s && s.status !== "processing" && s.status !== "recording";
}, 40000);

const events = await readStore(extPage, "events");
console.log(`\n=== ${events.length} EVENTS ===`);
for (const e of events) {
  const loc = e.locator ? `${e.locator.strategy}="${String(e.locator.primary.value).slice(0, 42)}"` : "-";
  console.log(`  ${String(e.index).padStart(2)} ${e.type.padEnd(12)} ${String(e.value).slice(0, 18).padEnd(18)} ${loc}`);
}

const net = await readStore(extPage, "networkEntries");
console.log(`\n=== ${net.length} NETWORK ===`);
for (const n of net) console.log(`  ${n.source.padEnd(18)} ${n.method} ${n.statusCode} ${String(n.url).slice(-46)}`);

const con = await readStore(extPage, "consoleEntries");
console.log(`\n=== ${con.length} CONSOLE ===`);
for (const c of con) console.log(`  ${c.level.padEnd(20)} ${String(c.message).slice(0, 90)}`);

const snaps = await readStore(extPage, "domSnapshots");
console.log(`\n=== ${snaps.length} SNAPSHOTS ===`);
for (const s of snaps) console.log(`  ${s.trigger.padEnd(18)} ${String(s.characterCount).padStart(6)} chars  truncated=${s.wasTruncated}`);

const session = (await readStore(extPage, "sessions"))[0];
console.log(`\n=== SCRIPT (${session.playwrightScript.length} chars) ===`);
console.log(session.playwrightScript || "(none generated - review page has not run)");

await browser.close();
await server.close();
