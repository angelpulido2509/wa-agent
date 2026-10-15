export type LlmProviderName = 'anthropic' | 'ollama' | 'openai-compatible' | 'stub';

export interface LlmConfig {
  provider: LlmProviderName;
  anthropicApiKey: string;
  anthropicModel: string;
  ollamaUrl: string;
  ollamaModel: string;
  ollamaNumCtx: number;
  ollamaTimeoutMs: number;
  ollamaKeepAlive: string;
  ollamaTemperature: number;
  ollamaNumPredict: number;
  /** openai-compatible (Groq, etc.) */
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  llmTemperature: number;
  llmMaxTokens: number;
  llmTimeoutMs: number;
  llmReasoningEffort: string | undefined;
  /** stub: regex (sin mayúsculas) que hace que el stub simule la tool transferir_a_humano. */
  stubHandoffPattern: string;
  businessName: string;
  knowledgePath: string;
  rulesPath: string;
}

export interface Config extends LlmConfig {
  testMode: boolean;
  testNumbers: Set<string>;
  panelToken: string;
  port: number;
  debounceMs: number;
  handoffPauseHours: number;
  maxRepliesPerHour: number;
  notifyOwner: boolean;
  logLevel: string;
  authDir: string;
  dbPath: string;
}

export const PROVIDERS: readonly LlmProviderName[] = ['anthropic', 'ollama', 'openai-compatible', 'stub'];
export const DEFAULT_PROVIDER: LlmProviderName = 'openai-compatible';
export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const DEFAULT_OLLAMA_MODEL = 'granite4.1:3b';
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
export const DEFAULT_LLM_MODEL = 'qwen/qwen3.8-27b';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'si', 'sí'].includes(value.trim().toLowerCase());
}

function num(env: Env, key: string, fallback: number, min = 0): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new ConfigError(`${key} debe ser un número >= ${min}`);
  return n;
}

export function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** Key propia de cada proveedor conocido: se usa si LLM_API_KEY está vacía. */
const KEY_BY_HOST: Record<string, string> = {
  'api.groq.com': 'GROQ_API_KEY',
  'generativelanguage.googleapis.com': 'GEMINI_API_KEY',
  'api.mistral.ai': 'MISTRAL_API_KEY',
};

/** Nombre de la variable con la key del proveedor de `baseUrl`, si es uno conocido. */
export function providerKeyVar(baseUrl: string): string | undefined {
  try {
    return KEY_BY_HOST[new URL(baseUrl).hostname];
  } catch {
    return undefined;
  }
}

export function isGroqUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.groq.com';
  } catch {
    return false;
  }
}

export const DEFAULT_STUB_HANDOFF_PATTERN = 'prueba handoff';

function stubPattern(env: Env): string {
  const pattern = env.STUB_HANDOFF_PATTERN?.trim() || DEFAULT_STUB_HANDOFF_PATTERN;
  try {
    new RegExp(pattern, 'i');
  } catch {
    throw new ConfigError('STUB_HANDOFF_PATTERN no es una expresión regular válida');
  }
  return pattern;
}

/** Configuración del LLM. Nunca incluye secretos en los mensajes de error. */
export function loadLlmConfig(env: Env = process.env): LlmConfig {
  const provider = (env.LLM_PROVIDER?.trim().toLowerCase() || DEFAULT_PROVIDER) as LlmProviderName;
  if (!PROVIDERS.includes(provider)) {
    throw new ConfigError(`LLM_PROVIDER debe ser uno de: ${PROVIDERS.join(', ')}`);
  }
  const anthropicApiKey = env.ANTHROPIC_API_KEY?.trim() ?? '';
  if (provider === 'anthropic' && !anthropicApiKey) {
    throw new ConfigError('LLM_PROVIDER=anthropic requiere ANTHROPIC_API_KEY en .env');
  }

  const llmBaseUrl = env.LLM_BASE_URL?.trim() || GROQ_BASE_URL;
  // Con un proveedor conocido (Groq, Gemini, Mistral), si LLM_API_KEY está vacía se usa su key propia.
  const keyVar = providerKeyVar(llmBaseUrl);
  const llmApiKey = env.LLM_API_KEY?.trim() || (keyVar ? env[keyVar]?.trim() ?? '' : '');
  if (provider === 'openai-compatible' && keyVar && !llmApiKey) {
    throw new ConfigError(`LLM_PROVIDER=openai-compatible con ${new URL(llmBaseUrl).hostname} requiere LLM_API_KEY o ${keyVar} en .env`);
  }

  return {
    provider,
    anthropicApiKey,
    anthropicModel: env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL,
    ollamaUrl: env.OLLAMA_URL?.trim() || 'http://localhost:11434',
    ollamaModel: env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL,
    ollamaNumCtx: num(env, 'OLLAMA_NUM_CTX', 16384, 2048),
    ollamaTimeoutMs: num(env, 'OLLAMA_TIMEOUT_MS', 300_000, 1000),
    ollamaKeepAlive: env.OLLAMA_KEEP_ALIVE?.trim() || '30m',
    // Temperatura baja: los modelos pequeños siguen mejor las reglas.
    ollamaTemperature: num(env, 'OLLAMA_TEMPERATURE', 0.2, 0),
    ollamaNumPredict: num(env, 'OLLAMA_NUM_PREDICT', 300, 16),
    llmBaseUrl,
    llmModel: env.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL,
    llmApiKey,
    llmTemperature: num(env, 'LLM_TEMPERATURE', 0.2, 0),
    llmMaxTokens: num(env, 'LLM_MAX_TOKENS', 600, 16),
    llmTimeoutMs: num(env, 'LLM_TIMEOUT_MS', 30_000, 1000),
    llmReasoningEffort: env.LLM_REASONING_EFFORT?.trim() || undefined,
    stubHandoffPattern: stubPattern(env),
    businessName: env.BUSINESS_NAME?.trim() || 'el negocio',
    knowledgePath: './knowledge/negocio.md',
    rulesPath: './knowledge/reglas.json',
  };
}

/** Configuración completa del bot. */
export function loadConfig(env: Env = process.env): Config {
  const llm = loadLlmConfig(env);

  const panelToken = env.PANEL_TOKEN?.trim() ?? '';
  if (panelToken.length < 12) throw new ConfigError('PANEL_TOKEN debe tener al menos 12 caracteres');

  const testNumbers = new Set(
    (env.TEST_NUMBERS ?? '')
      .split(',')
      .map(onlyDigits)
      .filter(Boolean),
  );
  const testMode = bool(env.TEST_MODE, true);
  // El stub responde textos fijos: jamás debe atender clientes reales.
  if (llm.provider === 'stub' && !testMode) {
    throw new ConfigError('LLM_PROVIDER=stub solo se permite con TEST_MODE=true (es un proveedor de pruebas)');
  }
  if (testMode && testNumbers.size === 0) {
    throw new ConfigError('TEST_MODE=true requiere al menos un número en TEST_NUMBERS');
  }

  return {
    ...llm,
    testMode,
    testNumbers,
    panelToken,
    port: num(env, 'PORT', 3000, 1),
    debounceMs: num(env, 'DEBOUNCE_MS', 4000),
    handoffPauseHours: num(env, 'HANDOFF_PAUSE_HOURS', 12),
    maxRepliesPerHour: num(env, 'MAX_REPLIES_PER_HOUR', 20, 1),
    notifyOwner: bool(env.NOTIFY_OWNER, true),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    authDir: './auth',
    dbPath: './data/wa-agent.db',
  };
}
