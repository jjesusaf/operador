// Spike: ¿OpenRouter acepta la tool nativa de computer use de Anthropic?
// Uso:  OPENROUTER_API_KEY=sk-or-... node openrouter-computer-use.mjs [modelo]
// Prueba 3 variantes y reporta cuál pasa. No gasta más que unos centavos.
const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error("Falta OPENROUTER_API_KEY"); process.exit(1); }
const model = process.argv[2] ?? "anthropic/claude-sonnet-4.5";

// Imagen 1x1 PNG (placeholder) para no depender de archivos.
const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function call(label, url, headers, body) {
  const t = Date.now();
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...headers }, body: JSON.stringify(body) });
  const txt = await r.text();
  console.log(`\n=== ${label} → HTTP ${r.status} (${Date.now() - t} ms)`);
  console.log(txt.slice(0, 1200));
  return r.status;
}

// A) Messages API de OpenRouter con tool nativa (varias versiones)
for (const [type, beta] of [["computer_toolset_20260801", null], ["computer_20251124", "computer-use-2025-11-24"], ["computer_20250124", "computer-use-2025-01-24"]]) {
  await call(`A · Messages API · ${type}`, "https://openrouter.ai/api/v1/messages",
    beta ? { "anthropic-beta": beta } : {},
    { model, max_tokens: 300,
      tools: [{ type, name: "computer", display_width_px: 1280, display_height_px: 800 }],
      messages: [{ role: "user", content: "Toma una captura de pantalla." }] });
}

// B) chat/completions con tool nativa (por si la pasan tal cual)
await call("B · chat/completions · tool nativa", "https://openrouter.ai/api/v1/chat/completions", {},
  { model, max_tokens: 300,
    tools: [{ type: "computer_20251124", name: "computer", display_width_px: 1280, display_height_px: 800 }],
    messages: [{ role: "user", content: "Toma una captura de pantalla." }] });

// C) Plan B: función común "computer" con el mismo esquema de acciones + imagen
await call("C · chat/completions · función común computer + imagen", "https://openrouter.ai/api/v1/chat/completions", {},
  { model, max_tokens: 300,
    tools: [{ type: "function", function: { name: "computer", description: "Opera la pantalla de 1280x800. Coordenadas en pixeles desde la esquina superior izquierda.",
      parameters: { type: "object", properties: {
        action: { type: "string", enum: ["screenshot", "left_click", "double_click", "type", "key", "scroll", "wait"] },
        coordinate: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 },
        text: { type: "string" }, scroll_direction: { type: "string", enum: ["up", "down"] }, scroll_amount: { type: "integer" } },
        required: ["action"] } } }],
    tool_choice: "required",
    messages: [{ role: "user", content: [
      { type: "text", text: "Esta es la pantalla actual. Da clic en el centro." },
      { type: "image_url", image_url: { url: `data:image/png;base64,${png1x1}` } } ] }] });
