import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { HANDOFF_TOOL_NAME, runAgent } from '../src/agent.js';
import { ConfigError, loadLlmConfig } from '../src/config.js';
import { toAnthropicMessages } from '../src/llm/anthropic.js';
import { LlmError, OllamaProvider } from '../src/llm/index.js';
import type { OllamaChatMessage } from '../src/llm/ollama.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-agent-llm-'));
const knowledgePath = path.join(tmpDir, 'negocio.md');
fs.writeFileSync(knowledgePath, '# Negocio de prueba\nPrecios: PENDIENTE');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

interface CapturedRequest {
  url: string;
  body: {
    model: string;
    messages: OllamaChatMessage[];
    tools: { type: string; function: { name: string; parameters: unknown } }[];
    stream: boolean;
    think: boolean;
    keep_alive: string;
    options: { num_ctx: number; num_predict: number; temperature?: number };
  };
}

/** fetch simulado: responde en orden y captura cada request. */
function mockFetch(responses: unknown[]) {
  const requests: CapturedRequest[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    const next = responses.shift();
    if (next === undefined) throw new Error('El mock no tiene más respuestas');
    if (next instanceof Response) return next;
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchFn, requests };
}

const ns = (ms: number) => ms * 1e6;

function ollamaReply(content: string, toolCalls?: unknown[]) {
  return {
    model: 'granite4.1:3b',
    message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 1200,
    eval_count: 40,
    total_duration: ns(5000),
    load_duration: ns(100),
    prompt_eval_duration: ns(3900),
    eval_duration: ns(1000),
  };
}

function provider(fetchFn: typeof fetch, timeoutMs = 10_000) {
  return new OllamaProvider({
    baseUrl: 'http://localhost:11434/',
    model: 'granite4.1:3b',
    numCtx: 16384,
    timeoutMs,
    keepAlive: '30m',
    fetch: fetchFn,
  });
}

const baseRequest = {
  system: [{ text: 'Reglas estables', cache: true }, { text: 'Fecha dinámica' }],
  messages: [{ role: 'user' as const, content: 'Hola' }],
  tools: [{ name: 'transferir_a_humano', description: 'Pasa a humano', parameters: { type: 'object' } }],
  maxTokens: 512,
};

describe('OllamaProvider', () => {
  test('usa la API nativa /api/chat con num_ctx, think:false, stream:false y tools', async () => {
    const { fetchFn, requests } = mockFetch([ollamaReply('¡Hola!')]);
    const res = await provider(fetchFn).chat(baseRequest);

    const req = requests[0]!;
    assert.equal(req.url, 'http://localhost:11434/api/chat');
    assert.doesNotMatch(req.url, /\/v1\//);
    assert.equal(req.body.model, 'granite4.1:3b');
    assert.equal(req.body.stream, false);
    assert.equal(req.body.think, false);
    assert.equal(req.body.keep_alive, '30m');
    assert.deepEqual(req.body.options, { num_ctx: 16384, num_predict: 512 });
    assert.deepEqual(req.body.messages[0], { role: 'system', content: 'Reglas estables\n\nFecha dinámica' });
    assert.deepEqual(req.body.messages[1], { role: 'user', content: 'Hola' });
    assert.equal(req.body.tools[0]?.type, 'function');
    assert.equal(req.body.tools[0]?.function.name, 'transferir_a_humano');

    assert.equal(res.text, '¡Hola!');
    assert.equal(res.stopReason, 'end');
    assert.equal(res.usage.inputTokens, 1200);
    assert.equal(res.usage.outputTokens, 40);
    assert.equal(res.usage.cacheReadTokens, 0);
  });

  test('parsea tool_calls (arguments como objeto o como string JSON) y los tiempos en ms', async () => {
    const { fetchFn } = mockFetch([
      ollamaReply('', [
        { function: { name: 'transferir_a_humano', arguments: { motivo: 'pide precio' } } },
        { function: { name: 'transferir_a_humano', arguments: '{"motivo":"quiere reunión"}' } },
      ]),
    ]);
    const llm = provider(fetchFn);
    const res = await llm.chat(baseRequest);
    assert.equal(res.stopReason, 'tool_use');
    assert.deepEqual(
      res.toolCalls.map((c) => c.input),
      [{ motivo: 'pide precio' }, { motivo: 'quiere reunión' }],
    );
    assert.notEqual(res.toolCalls[0]?.id, res.toolCalls[1]?.id);
    assert.deepEqual(llm.lastTimings, { totalMs: 5000, loadMs: 100, promptEvalMs: 3900, evalMs: 1000 });
  });

  test('done_reason "length" se reporta como max_tokens', async () => {
    const { fetchFn } = mockFetch([{ ...ollamaReply('texto cortado'), done_reason: 'length' }]);
    assert.equal((await provider(fetchFn).chat(baseRequest)).stopReason, 'max_tokens');
  });

  test('errores HTTP, de conexión y timeout se convierten en LlmError', async () => {
    const http = mockFetch([new Response('model "x" not found', { status: 404 })]);
    await assert.rejects(provider(http.fetchFn).chat(baseRequest), (err: unknown) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.status, 404);
      assert.match(err.message, /not found/);
      return true;
    });

    const refused = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await assert.rejects(provider(refused).chat(baseRequest), /¿está corriendo Ollama\?/);

    const hang = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        // AbortSignal.timeout usa un timer unref: este mantiene vivo el event loop del test.
        const keepAlive = setTimeout(() => undefined, 5_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(keepAlive);
          reject(init.signal?.reason);
        });
      })) as typeof fetch;
    await assert.rejects(provider(hang, 50).chat(baseRequest), /OLLAMA_TIMEOUT_MS/);
  });

  test('ciclo completo del agente: tool_call → mensaje role "tool" → texto final', async () => {
    const { fetchFn, requests } = mockFetch([
      ollamaReply('', [{ function: { name: HANDOFF_TOOL_NAME, arguments: { motivo: 'Pide precio de un ERP' } } }]),
      ollamaReply('Eso lo define el equipo según cada caso. Una persona te escribirá por aquí.'),
    ]);
    const result = await runAgent({
      llm: provider(fetchFn),
      businessName: 'Negocio Test',
      knowledgePath,
      history: [{ role: 'user', text: '¿Cuánto cuesta un ERP?' }],
    });

    assert.deepEqual(result.handoff, { motivo: 'Pide precio de un ERP' });
    assert.match(result.reply ?? '', /persona te escribirá/);
    assert.equal(result.usage.calls, 2);
    assert.equal(result.usage.inputTokens, 2400);

    const second = requests[1]!.body.messages;
    assert.equal(second.length, 4); // system, user, assistant(tool_calls), tool
    assert.deepEqual(second[2]?.tool_calls, [
      { function: { name: HANDOFF_TOOL_NAME, arguments: { motivo: 'Pide precio de un ERP' } } },
    ]);
    assert.equal(second[3]?.role, 'tool');
    assert.equal(second[3]?.tool_name, HANDOFF_TOOL_NAME);
    assert.match(second[3]?.content ?? '', /Transferencia registrada/);
  });

  test('una tool desconocida se devuelve como error y el loop continúa', async () => {
    const { fetchFn, requests } = mockFetch([
      ollamaReply('', [{ function: { name: 'buscar_precio', arguments: {} } }]),
      ollamaReply('Te ayudo con gusto.'),
    ]);
    const result = await runAgent({
      llm: provider(fetchFn),
      businessName: 'Negocio Test',
      knowledgePath,
      history: [{ role: 'user', text: 'Hola' }],
    });
    assert.equal(result.handoff, null);
    assert.equal(result.reply, 'Te ayudo con gusto.');
    assert.match(requests[1]!.body.messages[3]?.content ?? '', /^ERROR: Herramienta desconocida/);
  });
});

describe('toAnthropicMessages', () => {
  test('agrupa tool results consecutivos en un solo turno user', () => {
    const out = toAnthropicMessages([
      { role: 'user', content: 'Hola' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 't1', name: 'a', input: {} },
          { id: 't2', name: 'b', input: {} },
        ],
      },
      { role: 'tool', toolCallId: 't1', name: 'a', content: 'ok' },
      { role: 'tool', toolCallId: 't2', name: 'b', content: 'falló', isError: true },
    ]);
    assert.equal(out.length, 3);
    assert.deepEqual(out[1], {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'a', input: {} },
        { type: 'tool_use', id: 't2', name: 'b', input: {} },
      ],
    });
    assert.deepEqual(out[2], {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
        { type: 'tool_result', tool_use_id: 't2', content: 'falló', is_error: true },
      ],
    });
  });
});

describe('loadLlmConfig', () => {
  test('ollama no exige API key', () => {
    const c = loadLlmConfig({ LLM_PROVIDER: 'ollama' });
    assert.equal(c.provider, 'ollama');
    assert.equal(c.ollamaUrl, 'http://localhost:11434');
    assert.equal(c.ollamaNumCtx, 16384);
  });

  test('anthropic exige ANTHROPIC_API_KEY sin incluirla en el error', () => {
    assert.throws(() => loadLlmConfig({ LLM_PROVIDER: 'anthropic' }), ConfigError);
    assert.equal(loadLlmConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test' }).provider, 'anthropic');
    assert.throws(() => loadLlmConfig({ LLM_PROVIDER: 'openai' }), /LLM_PROVIDER/);
  });

  test('lee OLLAMA_MODEL, OLLAMA_NUM_CTX y OLLAMA_TIMEOUT_MS', () => {
    const c = loadLlmConfig({ LLM_PROVIDER: 'ollama', OLLAMA_MODEL: 'granite4.1:8b', OLLAMA_NUM_CTX: '8192', OLLAMA_TIMEOUT_MS: '60000' });
    assert.equal(c.ollamaModel, 'granite4.1:8b');
    assert.equal(c.ollamaNumCtx, 8192);
    assert.equal(c.ollamaTimeoutMs, 60000);
    assert.throws(() => loadLlmConfig({ LLM_PROVIDER: 'ollama', OLLAMA_NUM_CTX: 'mucho' }), ConfigError);
  });
});

describe('toWhatsAppFormat', () => {
  test('convierte Markdown a formato WhatsApp sin cambiar el contenido', async () => {
    const { toWhatsAppFormat } = await import('../src/format.js');
    assert.equal(toWhatsAppFormat('**Hola** y __chao__'), '*Hola* y _chao_');
    assert.equal(toWhatsAppFormat('## Servicios\n- ERP'), '*Servicios*\n- ERP');
    assert.equal(toWhatsAppFormat('Mira [la web](https://devbull.com)'), 'Mira la web (https://devbull.com)');
    assert.equal(toWhatsAppFormat('*ya bien* _ok_'), '*ya bien* _ok_');
    assert.equal(toWhatsAppFormat('¿Qué proceso quieres mejorar?_'), '¿Qué proceso quieres mejorar?');
    assert.equal(toWhatsAppFormat('Somos *DevBull*'), 'Somos *DevBull*');
  });
});

describe('OllamaProvider num_predict', () => {
  test('limita num_predict a maxOutputTokens y envía la temperatura', async () => {
    const { fetchFn, requests } = mockFetch([ollamaReply('ok')]);
    const llm = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      model: 'granite4.1:3b',
      numCtx: 8192,
      timeoutMs: 10_000,
      temperature: 0.2,
      maxOutputTokens: 300,
      fetch: fetchFn,
    });
    await llm.chat({ ...baseRequest, maxTokens: 1024 });
    assert.deepEqual(requests[0]?.body.options, { num_ctx: 8192, num_predict: 300, temperature: 0.2 });
  });
});

describe('recuperación de tool calls escritos como texto', () => {
  test('el JSON de una tool conocida en el texto se convierte en tool call y no se envía al cliente', async () => {
    const leaked = '{"name": "transferir_a_humano", "arguments": {"motivo": "Pide precio de un ERP"}}';
    const { fetchFn } = mockFetch([ollamaReply(leaked), ollamaReply('Una persona del equipo te escribirá por aquí.')]);
    const result = await runAgent({
      llm: provider(fetchFn),
      businessName: 'Negocio Test',
      knowledgePath,
      history: [{ role: 'user', text: '¿Cuánto cuesta un ERP?' }],
    });
    assert.deepEqual(result.handoff, { motivo: 'Pide precio de un ERP' });
    assert.doesNotMatch(result.reply ?? '', /transferir_a_humano|"motivo"/);
  });

  test('no toca texto normal ni JSON de tools desconocidas', async () => {
    const { recoverTextToolCall } = await import('../src/llm/ollama.js');
    assert.equal(recoverTextToolCall('Hola, ¿en qué te ayudo?', ['transferir_a_humano']), null);
    assert.equal(recoverTextToolCall('{"name": "borrar_todo", "arguments": {}}', ['transferir_a_humano']), null);
    assert.deepEqual(
      recoverTextToolCall('```json\n{"name":"transferir_a_humano","parameters":{"motivo":"x"}}\n```', ['transferir_a_humano']),
      { name: 'transferir_a_humano', input: { motivo: 'x' } },
    );
  });
});
