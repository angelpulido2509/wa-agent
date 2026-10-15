import { parseArguments, recoverTextToolCall } from './tool-text.js';
import { LlmError, type LlmMessage, type LlmProvider, type LlmRequest, type LlmResponse, type LlmToolCall } from './types.js';

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  /** Ventana de contexto pedida por request (options.num_ctx). */
  numCtx: number;
  timeoutMs: number;
  /** Cuánto tiempo mantener el modelo cargado tras la última llamada (p. ej. "30m"). */
  keepAlive?: string;
  temperature?: number;
  /** Tope de tokens generados (options.num_predict). En CPU limita la latencia de respuestas largas. */
  maxOutputTokens?: number;
  /** Inyectable para tests. */
  fetch?: typeof fetch;
}

/** Mensaje de la API nativa /api/chat. */
export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

interface OllamaToolCallRaw {
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

interface OllamaChatResponse {
  message?: { role?: string; content?: string; tool_calls?: OllamaToolCallRaw[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

/** Tiempos que reporta Ollama (ms), útiles para medir latencia en CPU. */
export interface OllamaTimings {
  totalMs: number;
  loadMs: number;
  promptEvalMs: number;
  evalMs: number;
}

const nsToMs = (ns: number | undefined) => Math.round((ns ?? 0) / 1e6);

export function toOllamaMessages(system: string, messages: LlmMessage[]): OllamaChatMessage[] {
  const out: OllamaChatMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                function: { name: c.name, arguments: (c.input ?? {}) as Record<string, unknown> },
              })),
            }
          : {}),
      });
    } else {
      out.push({ role: 'tool', tool_name: m.name, content: m.isError ? `ERROR: ${m.content}` : m.content });
    }
  }
  return out;
}

export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama' as const;
  readonly model: string;
  /** Tiempos de la última llamada. */
  lastTimings: OllamaTimings | null = null;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: OllamaOptions) {
    this.model = opts.model;
    this.fetchFn = opts.fetch ?? fetch;
  }

  async chat(req: LlmRequest): Promise<LlmResponse> {
    const startedAt = Date.now();
    const body = {
      model: this.model,
      messages: toOllamaMessages(req.system.map((b) => b.text).join('\n\n'), req.messages),
      tools: req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      stream: false,
      think: false,
      keep_alive: this.opts.keepAlive ?? '30m',
      options: {
        num_ctx: this.opts.numCtx,
        num_predict: Math.min(req.maxTokens, this.opts.maxOutputTokens ?? req.maxTokens),
        ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
      },
    };

    let res: Response;
    try {
      res = await this.fetchFn(`${this.opts.baseUrl.replace(/\/+$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      const reason =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
          ? `sin respuesta en ${this.opts.timeoutMs} ms (OLLAMA_TIMEOUT_MS)`
          : `no se pudo conectar a ${this.opts.baseUrl} (¿está corriendo Ollama?)`;
      throw new LlmError(`Ollama: ${reason}`, 'ollama');
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new LlmError(`Ollama respondió ${res.status}: ${detail.slice(0, 300)}`, 'ollama', res.status);
    }

    const data = (await res.json()) as OllamaChatResponse;
    const toolCalls: LlmToolCall[] = (data.message?.tool_calls ?? [])
      .filter((c) => c.function?.name)
      .map((c, i) => ({
        id: c.id ?? `call_${startedAt}_${i}`,
        name: c.function!.name!,
        input: parseArguments(c.function!.arguments),
      }));

    let text = (data.message?.content ?? '').trim();
    if (toolCalls.length === 0) {
      const recovered = recoverTextToolCall(text, req.tools.map((t) => t.name));
      if (recovered) {
        toolCalls.push({ id: `call_${startedAt}_text`, ...recovered });
        text = '';
      }
    }

    this.lastTimings = {
      totalMs: nsToMs(data.total_duration),
      loadMs: nsToMs(data.load_duration),
      promptEvalMs: nsToMs(data.prompt_eval_duration),
      evalMs: nsToMs(data.eval_duration),
    };

    return {
      text,
      toolCalls,
      stopReason: toolCalls.length ? 'tool_use' : data.done_reason === 'length' ? 'max_tokens' : 'end',
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        latencyMs: Date.now() - startedAt,
      },
    };
  }
}

export { recoverTextToolCall } from './tool-text.js';
