import { parseArguments, recoverTextToolCall } from './tool-text.js';
import { LlmError, type LlmMessage, type LlmProvider, type LlmRequest, type LlmResponse, type LlmToolCall } from './types.js';

export interface OpenAICompatibleOptions {
  /** p. ej. https://api.groq.com/openai/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /** Tope de tokens generados por respuesta. */
  maxTokens: number;
  timeoutMs: number;
  /** Intentos totales ante 429/5xx (incluye el primero). */
  maxAttempts?: number;
  /** Espera máxima entre reintentos, aunque Retry-After pida más. */
  maxRetryWaitMs?: number;
  /** Solo modelos de razonamiento (p. ej. gpt-oss): low | medium | high. */
  reasoningEffort?: string;
  /** Inyectables para tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Estado de rate limit informado por el servidor en la última respuesta (headers x-ratelimit-*). */
export interface RateLimitInfo {
  remainingRequests: number | null;
  remainingTokens: number | null;
  resetTokensMs: number | null;
}

interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

interface ErrorBody {
  error?: { message?: string; code?: string; failed_generation?: string };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Convierte "7.66s", "2m59.5s", "450ms" (formato de Groq/OpenAI) a ms. */
export function parseDurationMs(value: string | null): number | null {
  if (!value) return null;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  for (const [, n, unit] of value.matchAll(re)) {
    matched = true;
    const v = Number(n);
    total += unit === 'h' ? v * 3_600_000 : unit === 'm' ? v * 60_000 : unit === 's' ? v * 1000 : v;
  }
  return matched ? Math.round(total) : null;
}

/** Retry-After puede venir en segundos o como fecha HTTP. */
export function parseRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export function toChatMessages(system: string, messages: LlmMessage[]): ChatCompletionMessage[] {
  const out: ChatCompletionMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
    } else {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.isError ? `ERROR: ${m.content}` : m.content });
    }
  }
  return out;
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly name = 'openai-compatible' as const;
  readonly model: string;
  lastRateLimit: RateLimitInfo | null = null;
  /** Reintentos hechos en la última llamada (para logs y escenarios). */
  lastRetries = 0;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.model = opts.model;
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private get host(): string {
    try {
      return new URL(this.opts.baseUrl).host;
    } catch {
      return this.opts.baseUrl;
    }
  }

  async chat(req: LlmRequest): Promise<LlmResponse> {
    const startedAt = Date.now();
    const toolNames = req.tools.map((t) => t.name);
    const body = {
      model: this.model,
      messages: toChatMessages(req.system.map((b) => b.text).join('\n\n'), req.messages),
      tools: req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: 'auto',
      temperature: this.opts.temperature,
      max_tokens: Math.min(req.maxTokens, this.opts.maxTokens),
      ...(this.opts.reasoningEffort ? { reasoning_effort: this.opts.reasoningEffort } : {}),
    };

    const maxAttempts = this.opts.maxAttempts ?? 3;
    const maxWait = this.opts.maxRetryWaitMs ?? 20_000;
    this.lastRetries = 0;

    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(`${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        throw new LlmError(
          timedOut
            ? `${this.host}: sin respuesta en ${this.opts.timeoutMs} ms (LLM_TIMEOUT_MS)`
            : `${this.host}: no se pudo conectar`,
          this.name,
        );
      }

      this.lastRateLimit = {
        remainingRequests: numHeader(res.headers.get('x-ratelimit-remaining-requests')),
        remainingTokens: numHeader(res.headers.get('x-ratelimit-remaining-tokens')),
        resetTokensMs: parseDurationMs(res.headers.get('x-ratelimit-reset-tokens')),
      };

      const retryable = res.status === 429 || res.status >= 500;
      if (res.status === 429) {
        // Cuota diaria agotada (p. ej. Gemini "Please retry in 11h…"): reintentar ahora es inútil.
        const raw = await res.text().catch(() => '');
        const waitMs = parseRetryAfterMs(res.headers.get('retry-after')) ?? quotaRetryDelayMs(raw);
        if (waitMs !== null && waitMs > maxWait) {
          throw new LlmError(
            `${this.host}: cuota agotada (429); se puede reintentar en ~${formatWait(waitMs)}. ${quotaSummary(raw)}`.trim(),
            this.name,
            429,
          );
        }
        if (attempt < maxAttempts) {
          const backoff = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
          this.lastRetries++;
          await this.sleep(Math.min(waitMs ?? backoff, maxWait));
          continue;
        }
        throw new LlmError(`${this.host} respondió 429 tras ${attempt} intentos: ${quotaSummary(raw) || raw.slice(0, 300)}`, this.name, 429);
      }
      if (retryable && attempt < maxAttempts) {
        await res.body?.cancel().catch(() => undefined);
        const retryAfter = parseRetryAfterMs(res.headers.get('retry-after'));
        const backoff = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
        this.lastRetries++;
        await this.sleep(Math.min(retryAfter ?? backoff, maxWait));
        continue;
      }

      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        const parsed = safeJson<ErrorBody>(raw);
        // Groq devuelve 400 tool_use_failed cuando el modelo genera una tool call mal formada.
        const failed = parsed?.error?.code === 'tool_use_failed' ? parsed.error.failed_generation : undefined;
        const recovered = failed ? recoverTextToolCall(failed, toolNames) : null;
        if (recovered) {
          return {
            text: '',
            toolCalls: [{ id: `call_${startedAt}_recovered`, ...recovered }],
            stopReason: 'tool_use',
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: Date.now() - startedAt },
          };
        }
        const detail = (parsed?.error?.message ?? raw).slice(0, 300);
        throw new LlmError(`${this.host} respondió ${res.status}${retryable ? ` tras ${attempt} intentos` : ''}: ${detail}`, this.name, res.status);
      }

      const data = (await res.json()) as ChatCompletionResponse;
      const choice = data.choices?.[0];
      const toolCalls: LlmToolCall[] = (choice?.message?.tool_calls ?? [])
        .filter((c) => c.function?.name)
        .map((c, i) => ({
          id: c.id ?? `call_${startedAt}_${i}`,
          name: c.function!.name!,
          input: parseArguments(c.function!.arguments),
        }));

      let text = (choice?.message?.content ?? '').trim();
      if (toolCalls.length === 0) {
        const recovered = recoverTextToolCall(text, toolNames);
        if (recovered) {
          toolCalls.push({ id: `call_${startedAt}_text`, ...recovered });
          text = '';
        }
      }

      return {
        text,
        toolCalls,
        stopReason: toolCalls.length ? 'tool_use' : choice?.finish_reason === 'length' ? 'max_tokens' : 'end',
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
          cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          cacheWriteTokens: 0,
          latencyMs: Date.now() - startedAt,
        },
      };
    }
  }
}

/** Espera pedida en el cuerpo de un 429: `"retryDelay": "39977s"` (Google) o "Please retry in 11h6m17s". */
export function quotaRetryDelayMs(body: string): number | null {
  const delay = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (delay) return Math.round(Number(delay[1]) * 1000);
  const text = body.match(/retry in ((?:\d+(?:\.\d+)?(?:h|ms|m|s))+)/i);
  return text ? parseDurationMs(text[1]!) : null;
}

/** Línea útil del 429 ("Quota exceeded for metric … limit: 20 …"), sin el resto del cuerpo. */
function quotaSummary(body: string): string {
  const m = body.match(/Quota exceeded for metric:[^"\\]*/i);
  return m ? m[0].trim().slice(0, 200) : '';
}

function formatWait(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${Math.max(1, min)} min`;
}

function numHeader(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
