import type Anthropic from '@anthropic-ai/sdk';
import type { LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmStopReason } from './types.js';

/** Subconjunto del cliente de Anthropic que usa el proveedor; permite inyectar un mock en tests. */
export interface AnthropicClientLike {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

/** Convierte el historial común al formato de la API (tool results consecutivos van en un solo turno user). */
export function toAnthropicMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      if (!m.toolCalls?.length) {
        out.push({ role: 'assistant', content: m.content });
        continue;
      }
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const call of m.toolCalls) blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      out.push({ role: 'assistant', content: blocks });
    } else {
      const result: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
        ...(m.isError ? { is_error: true } : {}),
      };
      const last = out.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(result);
      else out.push({ role: 'user', content: [result] });
    }
  }
  return out;
}

function mapStop(reason: Anthropic.StopReason | null): LlmStopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;

  constructor(
    private readonly client: AnthropicClientLike,
    readonly model: string,
  ) {}

  async chat(req: LlmRequest): Promise<LlmResponse> {
    const startedAt = Date.now();
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens,
      system: req.system.map((b) =>
        b.cache ? { type: 'text', text: b.text, cache_control: { type: 'ephemeral' } } : { type: 'text', text: b.text },
      ),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema,
      })),
      messages: toAnthropicMessages(req.messages),
    });

    return {
      text: response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim(),
      toolCalls: response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input })),
      stopReason: mapStop(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        latencyMs: Date.now() - startedAt,
      },
    };
  }
}
