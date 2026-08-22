import { chromium } from "playwright";
import fs from "node:fs";
const B="/tmp/claude-1000/-home-panda-Desktop-Tester-Reporter-AI/45e7ecad-a1fd-42ee-aae6-f084392d2708/scratchpad/";
const sel=fs.readFileSync(B+"selector.mjs","utf8");
const prune=fs.readFileSync(B+"prune-dom.js","utf8");
const ctx=fs.readFileSync(B+"element-context.js","utf8");
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
for (const [rows,cols] of [[150,6],[300,6],[500,8]]) {
  await page.setContent(html(rows,cols));
  const count = await page.evaluate(()=>document.querySelectorAll("*").length);
  const r = await page.evaluate(async ({sel,prune,ctx})=>{
    const u=s=>URL.createObjectURL(new Blob([s],{type:"text/javascript"}));
    const S=await import(u(sel)), P=await import(u(prune)), C=await import(u(ctx));
    const btn=document.querySelector('[data-testid="view-5"]');
    S.getElementSelector(btn); P.pruneDomForAI(document,{maxTotalCharacters:40000}); C.captureElementContext(btn);
    const m=f=>{const t0=performance.now();f();return performance.now()-t0;};
    return { sel:m(()=>S.getElementSelector(btn)), prune:m(()=>P.pruneDomForAI(document,{maxTotalCharacters:40000})), ctx:m(()=>C.captureElementContext(btn)) };
  },{sel,prune,ctx});
  console.log(`elements=${count}  selector=${r.sel.toFixed(0)}ms  pruneSnapshot=${r.prune.toFixed(0)}ms  elementContext=${r.ctx.toFixed(0)}ms  TOTAL=${(r.sel+r.prune+r.ctx).toFixed(0)}ms`);
}
await browser.close();
