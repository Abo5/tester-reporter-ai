import { chromium } from "playwright";
import fs from "node:fs";
const src = fs.readFileSync("/tmp/claude-1000/-home-panda-Desktop-Tester-Reporter-AI/45e7ecad-a1fd-42ee-aae6-f084392d2708/scratchpad/selector.mjs","utf8");
const browser = await chromium.launch();
const page = await browser.newPage();
function html(rows, cols) {
  let s = `<!doctype html><html><body><div><div><main><section><div><table><tbody>`;
  for (let r=0;r<rows;r++){
    s += `<tr>`;
    for (let c=0;c<cols;c++) s += `<td><div><div><span>R${r}C${c}</span></div></div></td>`;
    s += `<td><div><div><button data-testid="view-${r}"><span><i></i></span><span>View</span></button></div></div></td></tr>`;
  }
  return s + `</tbody></table></div></section></main></div></div></body></html>`;
}
for (const [rows, cols] of [[40,5],[80,5],[150,6]]) {
  await page.setContent(html(rows, cols));
  const count = await page.evaluate(()=>document.querySelectorAll("*").length);
  const res = await page.evaluate(async ({src}) => {
    const mod = await import(URL.createObjectURL(new Blob([src],{type:"text/javascript"})));
    const btn = document.querySelector('[data-testid="view-5"]');
    mod.getElementSelector(btn);
    const t=[]; for(let i=0;i<3;i++){const t0=performance.now();mod.getElementSelector(btn);t.push(performance.now()-t0);}
    return t;
  }, {src});
  console.log(`elements=${count} times(ms)=${res.map(x=>x.toFixed(1)).join(", ")}`);
}

// Real-world ordering proof: capture-phase listener doing the work vs app handler
await page.setContent(html(150,6));
const order = await page.evaluate(async ({src}) => {
  const mod = await import(URL.createObjectURL(new Blob([src],{type:"text/javascript"})));
  const marks = [];
  document.addEventListener("click", (e) => {
    const t0 = performance.now();
    mod.getElementSelector(e.target.closest("button"));
    marks.push(["recorder capture handler done", performance.now()-t0]);
  }, true);
  const btn = document.querySelector('[data-testid="view-5"]');
  let appDelay = 0;
  const dispatched = performance.now();
  btn.addEventListener("click", () => { appDelay = performance.now()-dispatched; });
  btn.click();
  return { marks, appDelay };
}, {src});
console.log("app handler fired after (ms):", order.appDelay.toFixed(1), " recorder work:", order.marks);
await browser.close();
