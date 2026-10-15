import Anthropic from '@anthropic-ai/sdk';
import type { LlmConfig } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { StubProvider } from './stub.js';
import type { LlmProvider } from './types.js';

export * from './types.js';
export { AnthropicProvider, type AnthropicClientLike } from './anthropic.js';
export { OllamaProvider, type OllamaTimings } from './ollama.js';
export { OpenAICompatibleProvider, type RateLimitInfo } from './openai-compatible.js';
export { STUB_REPLIES, StubProvider } from './stub.js';

export interface LlmDeps {
  /** Para que el stub marque sus respuestas en los logs con [STUB]. */
  log?: (message: string, data: Record<string, unknown>) => void;
}

/** Crea el proveedor elegido con LLM_PROVIDER. */
export function createLlm(config: LlmConfig, deps: LlmDeps = {}): LlmProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(new Anthropic({ apiKey: config.anthropicApiKey }), config.anthropicModel);
    case 'ollama':
      return new OllamaProvider({
        baseUrl: config.ollamaUrl,
        model: config.ollamaModel,
        numCtx: config.ollamaNumCtx,
        timeoutMs: config.ollamaTimeoutMs,
        keepAlive: config.ollamaKeepAlive,
        temperature: config.ollamaTemperature,
        maxOutputTokens: config.ollamaNumPredict,
      });
    case 'openai-compatible':
      return new OpenAICompatibleProvider({
        baseUrl: config.llmBaseUrl,
        apiKey: config.llmApiKey,
        model: config.llmModel,
        temperature: config.llmTemperature,
        maxTokens: config.llmMaxTokens,
        timeoutMs: config.llmTimeoutMs,
        reasoningEffort: config.llmReasoningEffort,
      });
    case 'stub':
      return new StubProvider({ handoffPattern: config.stubHandoffPattern, log: deps.log });
  }
}

/** Descripción corta para logs (sin secretos). */
export function describeLlm(config: LlmConfig): string {
  switch (config.provider) {
    case 'anthropic':
      return `anthropic · ${config.anthropicModel}`;
    case 'ollama':
      return `ollama · ${config.ollamaModel} · num_ctx=${config.ollamaNumCtx} · ${config.ollamaUrl}`;
    case 'openai-compatible':
      return (
        `openai-compatible · ${config.llmModel} · ${new URL(config.llmBaseUrl).host} · max_tokens=${config.llmMaxTokens}` +
        (config.llmReasoningEffort ? ` · reasoning_effort=${config.llmReasoningEffort}` : '')
      );
    case 'stub':
      return `[STUB] respuestas fijas de prueba · handoff simulado con /${config.stubHandoffPattern}/i`;
  }
}
