// Manual smoke test for the desktop connector. Each argument is an action; a screenshot is saved after each.
//   pnpm smoke "click 123 48" "type Papelería Ñandú" "key Return"
// Actions: shot · click X Y · dblclick X Y · move X Y · type TEXT · replace TEXT · key COMBO · scroll X Y up|down · wait MS
import { mkdirSync, writeFileSync } from "node:fs";
import { Desktop } from "../src/desktop.js";

const actions = process.argv.slice(2);
mkdirSync("spikes/out", { recursive: true });
const t0 = Date.now();
const desktop = await Desktop.connect(process.env.DESKTOP_WSS!, process.env.DESKTOP_PASSWORD!);
console.log(`connected ${desktop.width}x${desktop.height} in ${Date.now() - t0} ms`);

let n = 0;
async function save(label: string, afterAction = false) {
  const t = Date.now(); const shot = await desktop.screenshot({ afterAction }); n++;
  const file = `spikes/out/smoke-${String(n).padStart(2, "0")}.png`; writeFileSync(file, shot.png);
  console.log(`  ${file} · settled in ${shot.waitMs} ms (changed: ${shot.changed}) · total ${Date.now() - t} ms · after "${label}"`);
}
await save("start");
for (const a of actions) {
  const [cmd, ...rest] = a.split(" "); const t = Date.now();
  switch (cmd) {
    case "shot": break;
    case "click": await desktop.click(+rest[0], +rest[1]); break;
    case "dblclick": await desktop.click(+rest[0], +rest[1], { double: true }); break;
    case "move": await desktop.moveMouse(+rest[0], +rest[1]); break;
    case "type": await desktop.typeText(rest.join(" ")); break;
    case "replace": await desktop.replaceText(rest.join(" ")); break;
    case "key": await desktop.pressKey(rest[0]); break;
    case "scroll": await desktop.scroll(+rest[0], +rest[1], rest[2] as "up" | "down"); break;
    case "wait": await new Promise((r) => setTimeout(r, +rest[0])); break;
    default: console.log(`  unknown action: ${a}`); continue;
  }
  console.log(`${a} → ${Date.now() - t} ms`);
  await save(a, cmd === "click" || cmd === "dblclick" || cmd === "key" || cmd === "scroll");
}
console.log(`input events sent: ${desktop.inputEventCount}`);
await desktop.close();
