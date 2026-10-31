// OpenRouter chat-completions client with the "computer" and "report" tools.
// We use plain function calling: OpenRouter rejects Anthropic's native computer-use tool.

export type ComputerAction =
  | { action: "screenshot" }
  | { action: "left_click" | "double_click" | "right_click" | "mouse_move"; coordinate: [number, number] }
  | { action: "type"; text: string }
  | { action: "key"; text: string }
  | { action: "scroll"; coordinate: [number, number]; scroll_direction: "up" | "down"; scroll_amount?: number }
  | { action: "wait"; duration?: number };

export interface ReportArgs { status: "done" | "failed"; summary: string; }

export const tools = [
  {
    type: "function",
    function: {
      name: "computer",
      description: "Operate the screen. Coordinates are pixels from the top-left of the latest screenshot. 'type' replaces the content of the focused field. 'key' presses a key or combo such as 'Return', 'Tab', 'Escape', 'ctrl+a', 'shift+Tab'. 'wait' pauses (default 1 s) so the app can repaint.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["screenshot", "left_click", "double_click", "right_click", "mouse_move", "type", "key", "scroll", "wait"] },
          coordinate: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2, description: "[x, y] for click/move/scroll" },
          text: { type: "string", description: "text to type, or key combo for 'key'" },
          scroll_direction: { type: "string", enum: ["up", "down"] },
          scroll_amount: { type: "integer", minimum: 1, maximum: 10 },
          duration: { type: "number", description: "seconds to wait (max 3)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "report",
      description: "Finish the task. Call exactly once, after verifying the result on screen.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["done", "failed"] },
          summary: { type: "string", description: "Short summary in Spanish. For questions include a line 'respuesta: <valor>'." },
        },
        required: ["status", "summary"],
      },
    },
  },
] as const;

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }

export interface ModelReply { message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }; toolCalls: ToolCall[]; text: string; cost: number; promptTokens: number; completionTokens: number; latencyMs: number; }

export interface ModelOptions { apiKey: string; model: string; maxTokens?: number; }

export async function chat(messages: ChatMessage[], opts: ModelOptions, signal?: AbortSignal, extra: { withTools?: boolean } = {}): Promise<ModelReply> {
  const t0 = Date.now();
  const withTools = extra.withTools ?? true;
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}`, "HTTP-Referer": "https://github.com/", "X-Title": "operador" },
    body: JSON.stringify({ model: opts.model, max_tokens: opts.maxTokens ?? 1024, temperature: 0, messages, usage: { include: true }, ...(withTools ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {}) }),
  });
  const body = await res.json() as any;
  if (!res.ok || body.error) throw new Error(`model error HTTP ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 500)}`);
  const message = body.choices?.[0]?.message ?? { role: "assistant", content: null };
  const toolCalls: ToolCall[] = message.tool_calls ?? [];
  return {
    message: { role: "assistant", content: message.content ?? null, tool_calls: toolCalls.length ? toolCalls : undefined },
    toolCalls, text: typeof message.content === "string" ? message.content : "",
    cost: Number(body.usage?.cost ?? 0), promptTokens: body.usage?.prompt_tokens ?? 0, completionTokens: body.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - t0,
  };
}
