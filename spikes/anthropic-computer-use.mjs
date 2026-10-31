// Spike: toolset nativo de computer use DIRECTO contra la API de Anthropic, con Sonnet 5.5.
// Uso:  ANTHROPIC_API_KEY=$(cat ~/.config/anthropic_key) node anthropic-computer-use.mjs [modelo]
const key = process.env.ANTHROPIC_API_KEY;
if (!key) { console.error("Falta ANTHROPIC_API_KEY"); process.exit(1); }
const model = process.argv[2] ?? "claude-sonnet-5-5";
const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function call(label, tools) {
  const t = Date.now();
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 300, tools,
      messages: [{ role: "user", content: [
        { type: "text", text: "Esta es la pantalla actual (1280x800). Da clic en el centro." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: png1x1 } } ] }] }) });
  const txt = await r.text();
  console.log(`\n=== ${label} → HTTP ${r.status} (${Date.now() - t} ms)`);
  console.log(txt.slice(0, 900));
  return r.status === 200;
}

const T = "computer_toolset_20260801";
const dims = { display_width_px: 1280, display_height_px: 800 };
const variants = [
  ["1 · toolset sin medidas", [{ type: T }]],
  ["2 · toolset + config", [{ type: T, config: dims }]],
  ["3 · toolset + defaults", [{ type: T, defaults: dims }]],
  ["4 · toolset + configs.computer", [{ type: T, configs: { computer: dims } }]],
  ["5 · toolset + computer:{...}", [{ type: T, computer: dims }]],
];
for (const [label, tools] of variants) {
  if (await call(label, tools)) { console.log(`\n>>> Forma válida: ${label}`); break; }
}
