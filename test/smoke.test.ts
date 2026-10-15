import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { HANDOFF_TOOL_NAME, historyToMessages, runAgent } from '../src/agent.js';
import { createDb } from '../src/db.js';
import { KeyedDebouncer } from '../src/debounce.js';
import { type AnthropicClientLike, AnthropicProvider } from '../src/llm/index.js';
import { buildServer, type GatewayPort } from '../src/server.js';
import type { GatewayStatus } from '../src/whatsapp.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-agent-test-'));
const knowledgePath = path.join(tmpDir, 'negocio.md');
fs.writeFileSync(knowledgePath, '# Negocio de prueba\nHorario: lunes a viernes 8:00–17:00.');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function usage(): Anthropic.Usage {
  return {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 0,
  } as Anthropic.Usage;
}

function message(content: Anthropic.ContentBlock[], stop_reason: Anthropic.StopReason): Anthropic.Message {
  return { id: 'msg_test', type: 'message', role: 'assistant', model: 'mock', content, stop_reason, usage: usage() } as Anthropic.Message;
}

/** Cliente simulado: devuelve las respuestas en orden y guarda una copia de cada request. */
function mockClient(responses: Anthropic.Message[]) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: AnthropicClientLike = {
    messages: {
      async create(params) {
        calls.push(structuredClone(params));
        const next = responses.shift();
        if (!next) throw new Error('El mock no tiene más respuestas');
        return next;
      },
    },
  };
  return { llm: new AnthropicProvider(client, 'mock-model'), calls };
}

describe('historyToMessages', () => {
  test('fusiona consecutivos del mismo rol, mapea bot/owner a assistant y empieza en user', () => {
    const out = historyToMessages([
      { role: 'bot', text: 'Mensaje antiguo del bot' },
      { role: 'owner', text: 'Y del dueño' },
      { role: 'user', text: 'Hola' },
      { role: 'user', text: '¿Tienen delivery?' },
      { role: 'bot', text: 'Sí' },
      { role: 'owner', text: 'Te escribo yo' },
      { role: 'user', text: '   ' },
      { role: 'user', text: 'Gracias' },
    ]);
    assert.deepEqual(out, [
      { role: 'user', content: 'Hola\n¿Tienen delivery?' },
      { role: 'assistant', content: 'Sí\nTe escribo yo' },
      { role: 'user', content: 'Gracias' },
    ]);
  });
});

describe('runAgent', () => {
  test('ciclo tool_use → tool_result → texto final, con cache_control en el system', async () => {
    const { llm, calls } = mockClient([
      message(
        [{ type: 'tool_use', id: 'toolu_1', name: HANDOFF_TOOL_NAME, input: { motivo: 'quiere pagar' } } as Anthropic.ToolUseBlock],
        'tool_use',
      ),
      message([{ type: 'text', text: 'Te paso con una persona 🙌', citations: null } as Anthropic.TextBlock], 'end_turn'),
    ]);

    const result = await runAgent({
      llm,
      businessName: 'Negocio Test',
      knowledgePath,
      history: [{ role: 'user', text: 'Quiero pagar mi pedido' }],
      now: new Date('2026-10-09T15:00:00Z'),
    });

    assert.equal(result.reply, 'Te paso con una persona 🙌');
    assert.deepEqual(result.handoff, { motivo: 'quiere pagar' });
    const { latencyMs, ...tokens } = result.usage;
    assert.ok(latencyMs >= 0);
    assert.deepEqual(tokens, { inputTokens: 20, outputTokens: 10, cacheReadTokens: 6, cacheWriteTokens: 0, calls: 2 });
    assert.equal(calls.length, 2);

    const first = calls[0]!;
    assert.ok(Array.isArray(first.system));
    const [stable, dynamic] = first.system as Anthropic.TextBlockParam[];
    assert.deepEqual(stable?.cache_control, { type: 'ephemeral' });
    assert.match(stable!.text, /Negocio de prueba/);
    assert.equal(dynamic?.cache_control, undefined);
    assert.match(dynamic!.text, /Caracas/);
    assert.equal((first.tools?.[0] as Anthropic.Tool | undefined)?.name, HANDOFF_TOOL_NAME);

    const second = calls[1]!;
    assert.equal(second.messages.length, 3);
    assert.equal(second.messages[1]?.role, 'assistant');
    const toolTurn = second.messages[2];
    assert.equal(toolTurn?.role, 'user');
    const block = (toolTurn?.content as Anthropic.ToolResultBlockParam[])[0];
    assert.equal(block?.type, 'tool_result');
    assert.equal(block?.tool_use_id, 'toolu_1');
    assert.notEqual(block?.is_error, true);
  });

  test('no llama a la API si el historial no termina en un mensaje del cliente', async () => {
    const { llm, calls } = mockClient([]);
    const result = await runAgent({
      llm,
      businessName: 'Negocio Test',
      knowledgePath,
      history: [{ role: 'user', text: 'Hola' }, { role: 'owner', text: 'Hola, ya te atiendo' }],
    });
    assert.equal(result.reply, null);
    assert.equal(calls.length, 0);
  });
});

describe('db', () => {
  test('deduplica por (jid, wa_id)', () => {
    const db = createDb(':memory:');
    const msg = { jid: '584121234567@s.whatsapp.net', waId: 'ABC', role: 'user' as const, text: 'Hola', ts: Date.now() };
    assert.equal(db.saveMessage(msg), true);
    assert.equal(db.saveMessage(msg), false);
    assert.equal(db.saveMessage({ ...msg, jid: 'otro@s.whatsapp.net' }), true);
    assert.equal(db.recentMessages(msg.jid).length, 1);
    db.close();
  });

  test('pausa, reanuda y cuenta respuestas de la última hora', () => {
    const db = createDb(':memory:');
    const jid = '584121234567@s.whatsapp.net';
    assert.equal(db.isPaused(jid), false);
    db.pauseChat(jid, Date.now() + 60_000, 'prueba');
    assert.equal(db.isPaused(jid), true);
    assert.equal(db.listChats()[0]?.pauseReason, 'prueba');
    db.resumeChat(jid);
    assert.equal(db.isPaused(jid), false);

    db.pauseChat(jid, Date.now() - 1, 'vencida');
    assert.equal(db.isPaused(jid), false, 'una pausa vencida no cuenta');

    db.saveMessage({ jid, waId: 'b1', role: 'bot', text: 'a', ts: Date.now() });
    db.saveMessage({ jid, waId: 'b2', role: 'bot', text: 'b', ts: Date.now() - 2 * 3_600_000 });
    db.saveMessage({ jid, waId: 'u1', role: 'user', text: 'c', ts: Date.now() });
    assert.equal(db.repliesLastHour(jid), 1);
    db.close();
  });
});

describe('server', () => {
  class FakeGateway extends EventEmitter implements GatewayPort {
    status: GatewayStatus = { status: 'open', qr: null, me: '584120000000', updatedAt: Date.now() };
    async logout() {}
  }

  test('responde 401 sin token y 200 con token', async () => {
    const db = createDb(':memory:');
    const token = 'token-de-prueba-123';
    const app = await buildServer({ db, gateway: new FakeGateway(), panelToken: token, handoffPauseHours: 12 });

    for (const [method, url] of [['GET', '/api/status'], ['GET', '/api/chats'], ['POST', '/api/logout']] as const) {
      const res = await app.inject({ method, url });
      assert.equal(res.statusCode, 401, `${method} ${url}`);
      assert.deepEqual(res.json(), { success: false, data: null, error: 'No autorizado' });
    }
    assert.equal((await app.inject({ url: '/api/status', headers: { 'x-panel-token': 'incorrecto' } })).statusCode, 401);

    const okHeader = await app.inject({ url: '/api/status', headers: { 'x-panel-token': token } });
    assert.equal(okHeader.statusCode, 200);
    assert.equal(okHeader.json().data.status, 'open');
    assert.equal((await app.inject({ url: `/api/chats?token=${token}` })).statusCode, 200);

    const panel = await app.inject({ url: '/' });
    assert.equal(panel.statusCode, 200, 'el HTML del panel es público; los datos no');

    await app.close();
    db.close();
  });
});

describe('debounce (ráfagas)', () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test('tres mensajes seguidos producen una sola respuesta coherente', async () => {
    const db = createDb(':memory:');
    const jid = '584121234567@s.whatsapp.net';
    const { llm, calls } = mockClient([
      message([{ type: 'text', text: 'Respuesta única', citations: null } as Anthropic.TextBlock], 'end_turn'),
    ]);
    const replies: string[] = [];
    const debouncer = new KeyedDebouncer(40, async (key) => {
      const { reply } = await runAgent({
        llm,
        businessName: 'Negocio Test',
        knowledgePath,
        history: db.recentMessages(key),
      });
      if (reply) replies.push(reply);
    });

    for (const [i, text] of ['Hola', 'tengo una ferretería', 'y llevo todo en Excel'].entries()) {
      db.saveMessage({ jid, waId: `m${i}`, role: 'user', text, ts: Date.now() + i });
      debouncer.schedule(jid);
      await wait(10);
    }
    await wait(120);

    assert.deepEqual(replies, ['Respuesta única']);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.messages, [{ role: 'user', content: 'Hola\ntengo una ferretería\ny llevo todo en Excel' }]);
    db.close();
  });

  test('un mensaje que llega durante la respuesta se procesa después, sin turnos en paralelo', async () => {
    let running = 0;
    let maxParallel = 0;
    let runs = 0;
    const debouncer = new KeyedDebouncer(20, async () => {
      running++;
      maxParallel = Math.max(maxParallel, running);
      runs++;
      await wait(60);
      running--;
    });
    debouncer.schedule('a');
    await wait(40); // ya está corriendo
    debouncer.schedule('a');
    await wait(150);
    assert.equal(runs, 2);
    assert.equal(maxParallel, 1);
  });

  test('cancel evita la respuesta (p. ej. cuando el dueño toma el chat)', async () => {
    let runs = 0;
    const debouncer = new KeyedDebouncer(20, async () => {
      runs++;
    });
    debouncer.schedule('a');
    debouncer.cancel('a');
    await wait(60);
    assert.equal(runs, 0);
  });
});
