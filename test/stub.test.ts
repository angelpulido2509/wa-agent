import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { runAgent } from '../src/agent.js';
import { ConfigError, loadConfig, loadLlmConfig } from '../src/config.js';
import { isMediaOnly } from '../src/guards/pre.js';
import { parseRules } from '../src/guards/rules.js';
import { parseBusinessRules } from '../src/guards/negocio.js';
import { createLlm, STUB_REPLIES, StubProvider } from '../src/llm/index.js';
import type { LlmProvider, LlmRequest } from '../src/llm/types.js';

const rules = parseBusinessRules(fs.readFileSync('knowledge/reglas.json', 'utf8'), fs.readFileSync('knowledge/negocio.md', 'utf8'));
const base = { businessName: 'DevBull', knowledgePath: 'knowledge/negocio.md', rules };
const env = { LLM_PROVIDER: 'stub', PANEL_TOKEN: 'token-de-prueba-123', TEST_NUMBERS: '584120000000' };

function stub() {
  const logs: string[] = [];
  const llm = new StubProvider({ handoffPattern: 'prueba handoff', log: (m) => logs.push(m) });
  return { llm, logs };
}

const req = (content: string): LlmRequest => ({
  system: [{ text: 'x' }],
  messages: [{ role: 'user', content }],
  tools: [{ name: 'transferir_a_humano', description: 'x', parameters: {} }],
  maxTokens: 100,
});

describe('configuración del stub', () => {
  test('se niega a arrancar con TEST_MODE=false', () => {
    assert.throws(() => loadConfig({ ...env, TEST_MODE: 'false' }), (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /stub solo se permite con TEST_MODE=true/);
      return true;
    });
  });

  test('arranca con TEST_MODE=true y no exige ninguna key', () => {
    const c = loadConfig({ ...env, TEST_MODE: 'true' });
    assert.equal(c.provider, 'stub');
    assert.equal(c.stubHandoffPattern, 'prueba handoff');
    assert.ok(createLlm(c) instanceof StubProvider);
  });

  test('STUB_HANDOFF_PATTERN configurable y validado', () => {
    assert.equal(loadLlmConfig({ LLM_PROVIDER: 'stub', STUB_HANDOFF_PATTERN: 'pasame|humano' }).stubHandoffPattern, 'pasame|humano');
    assert.throws(() => loadLlmConfig({ LLM_PROVIDER: 'stub', STUB_HANDOFF_PATTERN: '([' }), ConfigError);
  });
});

describe('StubProvider', () => {
  test('respuesta fija, determinista y marcada [STUB] en los logs', async () => {
    const { llm, logs } = stub();
    const a = await llm.chat(req('Hola'));
    const b = await llm.chat(req('Hola'));
    assert.equal(a.text, STUB_REPLIES.default(1));
    assert.equal(a.text, b.text);
    assert.deepEqual(a.toolCalls, []);
    assert.ok(logs.length === 2 && logs.every((l) => l.startsWith('[STUB]')));
  });

  test('cuenta los mensajes de una ráfaga (llegan fusionados, una línea por mensaje)', async () => {
    const { llm } = stub();
    assert.match((await llm.chat(req('Hola\ntengo una duda\nes sobre mi negocio'))).text, /recibí 3 mensajes/);
  });

  test('simula transferir_a_humano cuando el mensaje coincide con el patrón', async () => {
    const { llm, logs } = stub();
    const res = await llm.chat(req('Esto es una PRUEBA HANDOFF'));
    assert.equal(res.stopReason, 'tool_use');
    assert.equal(res.toolCalls[0]?.name, 'transferir_a_humano');
    assert.equal((res.toolCalls[0]?.input as { motivo: string }).motivo, '«Esto es una PRUEBA HANDOFF»');
    assert.ok(logs.some((l) => l.startsWith('[STUB] simula tool call')));
  });

  test('tras el resultado de la tool responde el cierre; si fue bloqueada, responde el diagnóstico', async () => {
    const { llm } = stub();
    const ok = await llm.chat({ ...req('x'), messages: [{ role: 'tool', toolCallId: 'c', name: 'transferir_a_humano', content: 'ok' }] });
    assert.equal(ok.text, STUB_REPLIES.afterHandoff);
    const blocked = await llm.chat({
      ...req('x'),
      messages: [{ role: 'tool', toolCallId: 'c', name: 'transferir_a_humano', content: 'NO TRANSFERIDO', isError: true }],
    });
    assert.equal(blocked.text, STUB_REPLIES.handoffBlocked);
  });
});

describe('stub + agente con guards', () => {
  test('su respuesta pasa los controles del primer mensaje (servicio + una pregunta)', async () => {
    const r = await runAgent({ ...base, llm: stub().llm, history: [{ role: 'user', text: 'todo lo anoto en una libreta' }] });
    assert.equal(r.source, 'model');
    assert.deepEqual(r.guardEvents, []);
  });

  test('handoff simulado en el primer mensaje: el guard lo bloquea', async () => {
    const r = await runAgent({ ...base, llm: stub().llm, history: [{ role: 'user', text: 'prueba handoff' }] });
    assert.equal(r.handoff, null);
    assert.equal(r.reply, STUB_REPLIES.handoffBlocked);
    assert.equal(r.guardEvents[0]?.action, 'blocked');
  });

  test('handoff simulado en un turno posterior: se transfiere con el motivo del stub', async () => {
    const r = await runAgent({
      ...base,
      llm: stub().llm,
      history: [
        { role: 'user', text: 'Hola' },
        { role: 'bot', text: STUB_REPLIES.default(1) },
        { role: 'user', text: 'prueba handoff' },
      ],
    });
    assert.equal(r.handoff?.motivo, '«prueba handoff»');
    assert.equal(r.reply, STUB_REPLIES.afterHandoff);
  });

  test('"precio" lo resuelve el guard previo, sin llamar al stub', async () => {
    const calls: unknown[] = [];
    const spy: LlmProvider = { name: 'stub', model: 'stub', chat: async (q) => (calls.push(q), stub().llm.chat(q)) };
    const r = await runAgent({ ...base, llm: spy, history: [{ role: 'user', text: '¿cuánto cuesta una app?' }] });
    assert.equal(r.source, 'guard-pre');
    assert.ok(r.handoff);
    assert.equal(calls.length, 0);
  });
});

describe('control de multimedia (independiente del proveedor)', () => {
  test('isMediaOnly', () => {
    assert.ok(isMediaOnly('[audio]'));
    assert.ok(isMediaOnly('[imagen]\n[audio]'));
    assert.ok(!isMediaOnly('[imagen] mira mi local'));
    assert.ok(!isMediaOnly('[audio]\nhola'));
    assert.ok(!isMediaOnly('audio'));
  });

  test('solo multimedia: pide texto sin consultar al modelo y sin derivar', async () => {
    const calls: unknown[] = [];
    const spy: LlmProvider = { name: 'stub', model: 'stub', chat: async (q) => (calls.push(q), stub().llm.chat(q)) };
    const r = await runAgent({ ...base, llm: spy, history: [{ role: 'user', text: '[audio]' }] });
    assert.equal(r.reply, rules.pre.medios?.respuesta);
    assert.equal(r.handoff, null);
    assert.equal(r.guardEvents[0]?.action, 'media');
    assert.equal(calls.length, 0);
  });
});
