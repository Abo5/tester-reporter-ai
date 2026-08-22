import { chromium } from "playwright";
import fs from "node:fs";

const src = fs.readFileSync("/tmp/claude-1000/-home-panda-Desktop-Tester-Reporter-AI/45e7ecad-a1fd-42ee-aae6-f084392d2708/scratchpad/selector.mjs","utf8");

const browser = await chromium.launch();
const page = await browser.newPage();

// Build a realistic enterprise data grid: rows x cols, nested wrappers.
function html(rows, cols) {
  let s = `<!doctype html><html><body><div class="app"><div class="shell"><main><section><div class="grid-wrap"><table><tbody>`;
  for (let r=0;r<rows;r++){
    s += `<tr data-row="${r}">`;
    for (let c=0;c<cols;c++){
      s += `<td><div class="cell"><div class="cell-inner"><span class="v">R${r}C${c}</span></div></div></td>`;
    }
    s += `<td><div class="actions"><div class="wrap"><button data-testid="view-${r}" class="view"><span class="ico"><i></i></span><span class="lbl">View</span></button></div></div></td>`;
    s += `</tr>`;
  }
  s += `</tbody></table></div></section></main></div></div></body></html>`;
  return s;
}

for (const [rows, cols] of [[100,6],[300,6],[600,6]]) {
  await page.setContent(html(rows, cols));
  const count = await page.evaluate(()=>document.querySelectorAll("*").length);
  const res = await page.evaluate(async ({src}) => {
    const blob = new Blob([src], {type:"text/javascript"});
    const mod = await import(URL.createObjectURL(blob));
    const btn = document.querySelector('[data-testid="view-5"]');
    // instrument getComputedStyle
    let gcs = 0;
    const orig = window.getComputedStyle.bind(window);
    window.getComputedStyle = function(...a){ gcs++; return orig(...a); };
    // warm
    mod.getElementSelector(btn);
    const warmGcs = gcs;
    const times = [];
    for (let i=0;i<3;i++){
      gcs = 0;
      const t0 = performance.now();
      const loc = mod.getElementSelector(btn);
      times.push(performance.now()-t0);
    }
    window.getComputedStyle = orig;
    const loc = mod.getElementSelector(btn);
    return { times, gcs, warmGcs, strategy: loc.strategy, primary: loc.primary.value };
  }, {src});
  console.log(`elements=${count}  gcsCalls=${res.gcs}  times(ms)=${res.times.map(t=>t.toFixed(1)).join(", ")}  strategy=${res.strategy} primary=${res.primary}`);
}
await browser.close();
