import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { runAgent } from '../src/agent.js';
import { inventedClaims, literalSummary, reviewHandoff } from '../src/guards/handoff.js';
import { describesProblem, postGuard } from '../src/guards/post.js';
import { preGuard } from '../src/guards/pre.js';
import { parseRules } from '../src/guards/rules.js';
import { parseBusinessRules } from '../src/guards/negocio.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/llm/types.js';

const rules = parseBusinessRules(fs.readFileSync('knowledge/reglas.json', 'utf8'), fs.readFileSync('knowledge/negocio.md', 'utf8'));
const knowledge = fs.readFileSync('knowledge/negocio.md', 'utf8');

// Frases de prueba propias de este archivo: no coinciden con los escenarios ni con el set held-out.
describe('preGuard: intenciones nuevas y combinaciones', () => {
  const positives: [string, string][] = [
    ['quiero hablar con una persona', 'persona'],
    ['me pueden pasar con un asesor?', 'persona'],
    ['prefiero que me atienda alguien', 'persona'],
    ['tengo un reclamo con el sistema que me hicieron', 'reclamo'],
    ['estoy molesto, nadie me responde', 'reclamo'],
    ['ustedes tienen soporte técnico?', 'reclamo'],
    ['en cuánto me lo entregan?', 'plazo'],
    ['y cuánto tardarían en hacerlo', 'plazo'],
  ];
  for (const [text, intent] of positives) {
    test(`deriva: "${text}" → ${intent}`, () => assert.equal(preGuard(text, rules)?.intent, intent));
  }
  const negatives = [
    'quiero hablar con ustedes de mi negocio porque todo es a mano',
    'manejo los reclamos de mis clientes en una hoja de cálculo',
    'mis clientes se quejan de que tardamos en responder',
    'no sé cuánto tiempo pierdo copiando datos',
    'cuánto inventario tengo es un misterio',
  ];
  for (const text of negatives) {
    test(`no deriva: "${text}"`, () => assert.equal(preGuard(text, rules), null));
  }
});

describe('reviewHandoff', () => {
  const ctx = (customerTexts: string[], firstContact: boolean) => ({
    firstContact,
    customerTexts,
    lastCustomerText: customerTexts.at(-1) ?? '',
    rules,
  });

  test('bloquea el handoff del modelo en el primer mensaje', () => {
    const d = reviewHandoff('Posible cliente con procesos manuales', ctx(['tengo un taller y todo es en papel'], true));
    assert.equal(d.allow, false);
    assert.match(d.note ?? '', /primer mensaje/);
  });

  test('reemplaza un motivo que inventa una cotización por un resumen literal', () => {
    const texts = ['tengo un taller y todo es en papel', 'somos 4 personas'];
    const d = reviewHandoff('Taller, 4 personas, todo en papel. Pide cotización.', ctx(texts, false));
    assert.equal(d.allow, true);
    assert.equal(d.motivo, literalSummary('somos 4 personas'));
    assert.match(d.note ?? '', /precio/);
  });

  test('mantiene motivos que solo reflejan lo que dijo el cliente', () => {
    const texts = ['tengo un taller y todo es en papel', 'somos 4 y queremos ordenar los pedidos'];
    const d = reviewHandoff('Taller de 4 personas; pedidos en papel; quiere ordenarlos', ctx(texts, false));
    assert.deepEqual(d, { allow: true, motivo: 'Taller de 4 personas; pedidos en papel; quiere ordenarlos' });
  });

  test('no marca como inventado lo que el cliente sí expresó (sin falsos positivos)', () => {
    assert.deepEqual(inventedClaims('Quiere agendar una llamada', ['me pueden llamar mañana?'], rules), []);
    assert.deepEqual(inventedClaims('Pagos móviles sin conciliar', ['concilio los pagos móviles a mano'], rules), []);
    assert.deepEqual(inventedClaims('Pregunta el precio del sistema', ['y eso cuánto me sale?'], rules), []);
    assert.deepEqual(inventedClaims('Quiere una demo', ['todo lo llevo en papel'], rules), ['reunion']);
  });
});

describe('regla de contenido del primer mensaje', () => {
  const first = (customerText: string) => ({ firstContact: true, customerText });

  test('detecta cuándo el cliente describe un problema', () => {
    assert.ok(describesProblem('llevo todo en una libreta y se me pierden los datos', rules));
    assert.ok(!describesProblem('Hola, buenas tardes', rules));
  });

  test('exige un servicio de negocio.md y una pregunta cuando hay un problema', () => {
    const problem = 'llevo todo en una libreta y se me pierden los datos';
    const sinServicio = postGuard('Entiendo, eso cansa mucho. ¿Cuántas personas son?', rules, knowledge, first(problem));
    assert.deepEqual(sinServicio.violations, ['sin_servicio']);
    const sinPregunta = postGuard('Entiendo. Podemos digitalizarlo con un sistema a medida.', rules, knowledge, first(problem));
    assert.deepEqual(sinPregunta.violations, ['sin_pregunta']);
    const bien = postGuard('Entiendo. Podemos digitalizarlo con un sistema a medida. ¿Cuántas personas son?', rules, knowledge, first(problem));
    assert.equal(bien.ok, true);
  });

  test('no aplica si no hay problema descrito o si no es el primer contacto', () => {
    assert.equal(postGuard('¡Hola! ¿En qué te puedo ayudar?', rules, knowledge, first('Hola')).ok, true);
    const later = { firstContact: false, customerText: 'todo es en papel' };
    assert.equal(postGuard('Perfecto, gracias por el dato. ¿Cuántos son?', rules, knowledge, later).ok, true);
  });
});

/** Proveedor falso con respuestas en orden; registra cada request. */
function scripted(responses: Partial<LlmResponse>[]) {
  const requests: LlmRequest[] = [];
  const llm: LlmProvider = {
    name: 'openai-compatible',
    model: 'fake',
    async chat(req) {
      requests.push(structuredClone(req));
      const next = responses.shift();
      if (!next) throw new Error('sin más respuestas');
      return {
        text: '',
        toolCalls: [],
        stopReason: 'end',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 1 },
        ...next,
      };
    },
  };
  return { llm, requests };
}

const handoffCall = (motivo: string) => ({
  toolCalls: [{ id: 'call_1', name: 'transferir_a_humano', input: { motivo } }],
  stopReason: 'tool_use' as const,
});
const base = { businessName: 'DevBull', knowledgePath: 'knowledge/negocio.md', rules };

describe('runAgent: handoff prematuro', () => {
  test('primer mensaje con problema: descarta la tool call y el modelo responde el diagnóstico', async () => {
    const { llm, requests } = scripted([
      handoffCall('Posible cliente: taller con todo en papel. Pide cotización.'),
      { text: 'Entiendo, el papel se pierde fácil. Podemos digitalizar eso con un sistema a medida. ¿Cuántas personas trabajan contigo?' },
    ]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: 'tengo un taller y todo lo anotamos en papel' }] });
    assert.equal(r.handoff, null);
    assert.equal(r.source, 'model');
    assert.match(r.reply ?? '', /sistema a medida/);
    assert.equal(r.guardEvents[0]?.stage, 'handoff');
    assert.equal(r.guardEvents[0]?.action, 'blocked');
    const toolMsg = requests[1]!.messages.at(-1);
    assert.equal(toolMsg?.role, 'tool');
    assert.match(toolMsg?.role === 'tool' ? toolMsg.content : '', /NO TRANSFERIDO/);
  });

  test('con intención explícita el guard previo deriva sin llamar al modelo', async () => {
    const { llm, requests } = scripted([]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: 'quiero hablar con una persona' }] });
    assert.equal(r.source, 'guard-pre');
    assert.equal(requests.length, 0);
  });

  test('en un turno posterior permite el handoff pero corrige el motivo inventado', async () => {
    const { llm } = scripted([handoffCall('Taller de 4 personas. Pide cotización.'), { text: 'Listo, una persona del equipo te escribirá por aquí.' }]);
    const r = await runAgent({
      ...base,
      llm,
      history: [
        { role: 'user', text: 'tengo un taller y todo lo anotamos en papel' },
        { role: 'bot', text: 'Entiendo. Podemos digitalizarlo con un sistema a medida. ¿Cuántas personas son?' },
        { role: 'user', text: 'somos 4' },
      ],
    });
    assert.equal(r.handoff?.motivo, literalSummary('somos 4'));
    assert.ok(r.guardEvents.some((e) => e.stage === 'handoff' && e.action === 'motivo'));
  });

  test('primer mensaje con problema y respuesta sin servicio: reintenta con la regla de contenido', async () => {
    const { llm, requests } = scripted([
      { text: 'Entiendo, eso cansa. ¿Cuántas personas son?' },
      { text: 'Entiendo. Podemos automatizar ese registro. ¿Cuántas personas son?' },
    ]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: 'tengo un taller y todo lo anotamos en papel' }] });
    assert.equal(r.source, 'guard-post-retry');
    assert.match(requests[1]!.system.at(-1)!.text, /no nombra ningún servicio/);
  });

  test('si tras el reintento solo falla el estilo, se acepta sin derivar a una persona', async () => {
    const { llm } = scripted([{ text: 'Entiendo, eso cansa. ¿Cuántos son?' }, { text: 'Uf, entiendo. ¿Cuántos son? ¿Y qué venden?' }]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: 'tengo un taller y todo lo anotamos en papel' }] });
    assert.equal(r.source, 'guard-post-fixed');
    assert.equal(r.reply, 'Uf, entiendo. ¿Cuántos son?');
    assert.equal(r.handoff, null);
  });
});

describe('precio con pronombre ("cuánto me sale")', () => {
  test('el guard previo lo deriva', () => assert.equal(preGuard('y eso cuánto me sale?', rules)?.intent, 'precio'));
});

describe('runAgent: respuesta truncada por max_tokens', () => {
  test('nunca envía media frase: reintenta y usa la respuesta completa', async () => {
    const { llm, requests } = scripted([
      { text: 'Hola, en DevBull desarrollamos software a medida, sistemas ERP, aplicaciones', stopReason: 'max_tokens' },
      { text: 'Hola, en DevBull desarrollamos software a medida y automatización. ¿Qué tipo de negocio tienes?' },
    ]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: 'Hola, ¿qué hacen?' }] });
    assert.equal(r.source, 'guard-post-retry');
    assert.match(r.reply ?? '', /¿Qué tipo de negocio tienes\?$/);
    assert.match(requests[1]!.system.at(-1)!.text, /quedó cortada/);
  });

  test('si vuelve a cortarse, responde el mensaje seguro', async () => {
    const { llm } = scripted([
      { text: 'Hola, en DevBull desarrollamos', stopReason: 'max_tokens' },
      { text: 'Hola, en DevBull', stopReason: 'max_tokens' },
    ]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: 'Hola, ¿qué hacen?' }] });
    assert.equal(r.source, 'guard-post-fallback');
    assert.equal(r.reply, rules.post.respuestaSegura);
  });
});
