import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HANDOFF_TOOL_NAME, runAgent } from '../src/agent.js';
import { ConfigError, loadLlmConfig } from '../src/config.js';
import { OpenAICompatibleProvider, parseDurationMs, parseRetryAfterMs } from '../src/llm/openai-compatible.js';
import { LlmError } from '../src/llm/types.js';

const FAKE_KEY = 'gsk_test_NO_ES_REAL_0123456789';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    messages: { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }[];
    tools: { type: string; function: { name: string } }[];
    tool_choice: string;
    temperature: number;
    max_tokens: number;
    reasoning_effort?: string;
  };
}

type Scripted = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> } | 'hang' | 'refuse';

function mockFetch(script: Scripted[]) {
  const calls: Captured[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    const next = script.shift();
    if (!next) return Promise.reject(new Error('El mock no tiene más respuestas'));
    if (next === 'refuse') return Promise.reject(new TypeError('fetch failed'));
    if (next === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        const keepAlive = setTimeout(() => undefined, 5_000); // AbortSignal.timeout es unref
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(keepAlive);
          reject(init.signal?.reason);
        });
      });
    }
    const body = next.json !== undefined ? JSON.stringify(next.json) : (next.text ?? '');
    return Promise.resolve(
      new Response(body, { status: next.status ?? 200, headers: { 'content-type': 'application/json', ...next.headers } }),
    );
  }) as typeof fetch;
  return { fetchFn, calls };
}

function completion(content: string | null, toolCalls?: unknown[], finish = 'stop') {
  return {
    choices: [{ message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }],
    usage: { prompt_tokens: 1500, completion_tokens: 30 },
  };
}

function provider(fetchFn: typeof fetch, extra: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}) {
  const waits: number[] = [];
  const p = new OpenAICompatibleProvider({
    baseUrl: 'https://api.groq.com/openai/v1/',
    apiKey: FAKE_KEY,
    model: 'llama-3.3-70b-versatile',
    temperature: 0.2,
    maxTokens: 400,
    timeoutMs: 10_000,
    fetch: fetchFn,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...extra,
  });
  return { p, waits };
}

const request = {
  system: [{ text: 'Reglas', cache: true }, { text: 'Fecha' }],
  messages: [{ role: 'user' as const, content: 'Hola' }],
  tools: [{ name: HANDOFF_TOOL_NAME, description: 'Pasa a humano', parameters: { type: 'object' } }],
  maxTokens: 1024,
};

/** Ninguna salida (mensaje de error) puede contener la key. */
function assertNoKey(value: unknown) {
  assert.ok(!JSON.stringify(value, Object.getOwnPropertyNames(value ?? {})).includes(FAKE_KEY), 'la key se filtró');
}

describe('OpenAICompatibleProvider', () => {
  test('éxito: POST a /chat/completions con formato OpenAI, Bearer y límites configurados', async () => {
    const { fetchFn, calls } = mockFetch([{ json: completion('¡Hola! Somos DevBull.') }]);
    const { p } = provider(fetchFn);
    const res = await p.chat(request);

    const c = calls[0]!;
    assert.equal(c.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(c.headers.authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(c.body.model, 'llama-3.3-70b-versatile');
    assert.equal(c.body.temperature, 0.2);
    assert.equal(c.body.max_tokens, 400, 'min(maxTokens de la request, LLM_MAX_TOKENS)');
    assert.equal(c.body.tool_choice, 'auto');
    assert.equal(c.body.tools[0]?.type, 'function');
    assert.deepEqual(c.body.messages[0], { role: 'system', content: 'Reglas\n\nFecha' });
    assert.equal(c.body.reasoning_effort, undefined);

    assert.equal(res.text, '¡Hola! Somos DevBull.');
    assert.equal(res.stopReason, 'end');
    assert.equal(res.usage.inputTokens, 1500);
    assert.equal(res.usage.outputTokens, 30);
  });

  test('tool call: parsea arguments (string JSON) y el loop envía role "tool" con tool_call_id', async () => {
    const { fetchFn, calls } = mockFetch([
      {
        json: completion(null, [
          { id: 'call_abc', type: 'function', function: { name: HANDOFF_TOOL_NAME, arguments: '{"motivo":"Quiere una propuesta"}' } },
        ], 'tool_calls'),
      },
      { json: completion('Una persona del equipo te escribirá por aquí.') },
    ]);
    const { p } = provider(fetchFn);
    const r = await runAgent({
      llm: p,
      businessName: 'DevBull',
      knowledgePath: 'knowledge/negocio.md',
      history: [{ role: 'user', text: 'Necesito una propuesta formal' }],
    });
    assert.deepEqual(r.handoff, { motivo: 'Quiere una propuesta' });
    const msgs = calls[1]!.body.messages;
    assert.equal(msgs[2]?.role, 'assistant');
    assert.deepEqual(msgs[2]?.tool_calls, [
      { id: 'call_abc', type: 'function', function: { name: HANDOFF_TOOL_NAME, arguments: '{"motivo":"Quiere una propuesta"}' } },
    ]);
    assert.equal(msgs[3]?.role, 'tool');
    assert.equal(msgs[3]?.tool_call_id, 'call_abc');
  });

  test('429: reintenta respetando Retry-After y luego responde', async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 429, json: { error: { message: 'Rate limit reached' } }, headers: { 'retry-after': '2' } },
      { json: completion('ok') },
    ]);
    const { p, waits } = provider(fetchFn);
    const res = await p.chat(request);
    assert.equal(res.text, 'ok');
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [2000]);
    assert.equal(p.lastRetries, 1);
  });

  test('429 persistente: máximo 3 intentos con backoff exponencial y error sin la key', async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 429, json: { error: { message: 'Rate limit' } } },
      { status: 429, json: { error: { message: 'Rate limit' } } },
      { status: 429, json: { error: { message: 'Rate limit' } } },
    ]);
    const { p, waits } = provider(fetchFn, { maxRetryWaitMs: 5000 });
    await assert.rejects(p.chat(request), (err: unknown) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.status, 429);
      assert.match(err.message, /tras 3 intentos/);
      assertNoKey(err);
      return true;
    });
    assert.equal(calls.length, 3);
    assert.ok(waits[0]! >= 500 && waits[0]! < 750, 'primer reintento: ~0,5 s');
    assert.ok(waits[1]! >= 1000 && waits[1]! < 1250, 'segundo reintento: ~1 s');
  });

  test('429 con Retry-After mayor al tope: lo respeta y no reintenta antes de tiempo', async () => {
    const { fetchFn, calls } = mockFetch([{ status: 429, json: { error: { message: 'Rate limit' } }, headers: { 'retry-after': '120' } }]);
    const { p, waits } = provider(fetchFn, { maxRetryWaitMs: 5000 });
    await assert.rejects(p.chat(request), /cuota agotada \(429\); se puede reintentar en ~2 min/);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  test('429 de cuota diaria de Gemini (retryDelay en el cuerpo): falla enseguida con el límite', async () => {
    const body = [
      {
        error: {
          code: 429,
          message:
            'You exceeded your current quota.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash\nPlease retry in 11h6m17.38s.',
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '39977s' }],
        },
      },
    ];
    const { fetchFn, calls } = mockFetch([{ status: 429, json: body }]);
    await assert.rejects(provider(fetchFn).p.chat(request), (err: unknown) => {
      assert.ok(err instanceof LlmError);
      assert.match(err.message, /cuota agotada.*~11 h 6 min.*limit: 20/);
      assertNoKey(err);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  test('500: reintenta y se recupera; 400 no se reintenta', async () => {
    const ok = mockFetch([{ status: 500, text: 'upstream error' }, { json: completion('recuperado') }]);
    assert.equal((await provider(ok.fetchFn).p.chat(request)).text, 'recuperado');

    const bad = mockFetch([{ status: 400, json: { error: { message: 'model not found' } } }]);
    await assert.rejects(provider(bad.fetchFn).p.chat(request), /400: model not found/);
    assert.equal(bad.calls.length, 1);
  });

  test('timeout y conexión rechazada → LlmError sin exponer la key', async () => {
    const hang = mockFetch(['hang']);
    await assert.rejects(provider(hang.fetchFn, { timeoutMs: 50 }).p.chat(request), (err: unknown) => {
      assert.ok(err instanceof LlmError);
      assert.match(err.message, /LLM_TIMEOUT_MS/);
      assertNoKey(err);
      return true;
    });
    const refused = mockFetch(['refuse']);
    await assert.rejects(provider(refused.fetchFn).p.chat(request), /no se pudo conectar/);
  });

  test('JSON de la tool escrito en el texto se recupera como tool call (no se envía al cliente)', async () => {
    const leaked = '{"name": "transferir_a_humano", "arguments": {"motivo": "Pide precio"}}';
    const { fetchFn } = mockFetch([{ json: completion(leaked) }, { json: completion('Una persona del equipo te escribirá.') }]);
    const r = await runAgent({
      llm: provider(fetchFn).p,
      businessName: 'DevBull',
      knowledgePath: 'knowledge/negocio.md',
      history: [{ role: 'user', text: 'necesito info' }],
    });
    assert.deepEqual(r.handoff, { motivo: 'Pide precio' });
    assert.doesNotMatch(r.reply ?? '', /transferir_a_humano|"motivo"/);
  });

  test('400 tool_use_failed de Groq: recupera la tool call desde failed_generation', async () => {
    const { fetchFn } = mockFetch([
      {
        status: 400,
        json: {
          error: {
            code: 'tool_use_failed',
            message: 'Failed to call a function',
            failed_generation: '<tool_call>{"name": "transferir_a_humano", "arguments": {"motivo": "Quiere reunión"}}</tool_call>',
          },
        },
      },
    ]);
    const res = await provider(fetchFn).p.chat(request);
    assert.equal(res.stopReason, 'tool_use');
    assert.deepEqual(res.toolCalls[0]?.input, { motivo: 'Quiere reunión' });
  });

  test('lee los headers de rate limit y envía reasoning_effort solo si se configura', async () => {
    const { fetchFn, calls } = mockFetch([
      {
        json: completion('ok'),
        headers: { 'x-ratelimit-remaining-tokens': '9500', 'x-ratelimit-remaining-requests': '29', 'x-ratelimit-reset-tokens': '2m3.5s' },
      },
    ]);
    const { p } = provider(fetchFn, { reasoningEffort: 'low', model: 'openai/gpt-oss-120b' });
    await p.chat(request);
    assert.deepEqual(p.lastRateLimit, { remainingRequests: 29, remainingTokens: 9500, resetTokensMs: 123_500 });
    assert.equal(calls[0]?.body.reasoning_effort, 'low');
  });
});

describe('parseo de duraciones', () => {
  test('parseDurationMs y parseRetryAfterMs', () => {
    assert.equal(parseDurationMs('7.66s'), 7660);
    assert.equal(parseDurationMs('450ms'), 450);
    assert.equal(parseDurationMs('1m30s'), 90_000);
    assert.equal(parseDurationMs(null), null);
    assert.equal(parseRetryAfterMs('3'), 3000);
    assert.equal(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000), 6_000);
    assert.equal(parseRetryAfterMs('basura'), null);
  });
});

describe('loadLlmConfig openai-compatible', () => {
  test('por defecto usa openai-compatible con Groq y toma GROQ_API_KEY si LLM_API_KEY está vacía', () => {
    const c = loadLlmConfig({ GROQ_API_KEY: FAKE_KEY });
    assert.equal(c.provider, 'openai-compatible');
    assert.equal(c.llmBaseUrl, 'https://api.groq.com/openai/v1');
    assert.equal(c.llmApiKey, FAKE_KEY);
    assert.equal(c.llmTemperature, 0.2);
    assert.equal(c.llmMaxTokens, 600);
  });

  test('LLM_API_KEY tiene prioridad; con Groq sin ninguna key falla sin mostrar secretos', () => {
    assert.equal(loadLlmConfig({ LLM_API_KEY: 'otra', GROQ_API_KEY: FAKE_KEY }).llmApiKey, 'otra');
    assert.throws(() => loadLlmConfig({ LLM_PROVIDER: 'openai-compatible' }), ConfigError);
  });

  test('GROQ_API_KEY no se usa para otros servidores; uno local no exige key', () => {
    const c = loadLlmConfig({ LLM_BASE_URL: 'http://localhost:8080/v1', GROQ_API_KEY: FAKE_KEY });
    assert.equal(c.llmApiKey, '');
  });
});

describe('keys por proveedor (Gemini, Mistral)', () => {
  test('toma GEMINI_API_KEY o MISTRAL_API_KEY según LLM_BASE_URL', () => {
    const gem = loadLlmConfig({ LLM_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai', GEMINI_API_KEY: 'g-key', GROQ_API_KEY: FAKE_KEY });
    assert.equal(gem.llmApiKey, 'g-key');
    const mis = loadLlmConfig({ LLM_BASE_URL: 'https://api.mistral.ai/v1', MISTRAL_API_KEY: 'm-key' });
    assert.equal(mis.llmApiKey, 'm-key');
  });

  test('sin la key del proveedor falla nombrando la variable, sin mostrar secretos', () => {
    assert.throws(
      () => loadLlmConfig({ LLM_PROVIDER: 'openai-compatible', LLM_BASE_URL: 'https://api.mistral.ai/v1', GEMINI_API_KEY: 'g-key' }),
      /MISTRAL_API_KEY/,
    );
  });
});
