/** Contrato común para cualquier proveedor de LLM que use el agente. */

export interface LlmToolDef {
  name: string;
  description: string;
  /** JSON Schema del input */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type LlmMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface LlmSystemBlock {
  text: string;
  /** Marca el bloque como prefijo cacheable (solo lo aprovechan proveedores con prompt caching). */
  cache?: boolean;
}

export interface LlmRequest {
  system: LlmSystemBlock[];
  messages: LlmMessage[];
  tools: LlmToolDef[];
  maxTokens: number;
}

export type LlmStopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Tiempo de pared de la llamada, en ms */
  latencyMs: number;
}

export interface LlmResponse {
  text: string;
  toolCalls: LlmToolCall[];
  stopReason: LlmStopReason;
  usage: LlmUsage;
}

export interface LlmProvider {
  readonly name: 'anthropic' | 'ollama' | 'openai-compatible' | 'stub';
  readonly model: string;
  chat(request: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  override name = 'LlmError';
  constructor(
    message: string,
    readonly provider: LlmProvider['name'],
    readonly status?: number,
  ) {
    super(message);
  }
}
