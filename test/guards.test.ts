import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { runAgent } from '../src/agent.js';
import { keepOneQuestion, postGuard } from '../src/guards/post.js';
import { preGuard } from '../src/guards/pre.js';
import { containsPhrase, normalize, parseRules, RulesError } from '../src/guards/rules.js';
import { parseBusinessRules } from '../src/guards/negocio.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/llm/types.js';

// Reglas y negocio reales del proyecto: los tests validan lo que corre en producción.
const rules = parseBusinessRules(fs.readFileSync('knowledge/reglas.json', 'utf8'), fs.readFileSync('knowledge/negocio.md', 'utf8'));
const knowledge = fs.readFileSync('knowledge/negocio.md', 'utf8');

describe('normalize / containsPhrase', () => {
  test('ignora mayúsculas, tildes y signos; compara palabras completas', () => {
    assert.equal(normalize('¿CUÁNTO cuesta?'), 'cuanto cuesta');
    assert.ok(containsPhrase(normalize('¿Cuánto cuesta un ERP?'), 'cuanto cuesta'));
    assert.ok(!containsPhrase(normalize('Uso JavaScript'), 'java'));
    assert.ok(!containsPhrase(normalize('mi internet falla'), 'net'));
  });
});

describe('preGuard', () => {
  const positives: [string, string][] = [
    ['¿Cuánto cuesta un ERP?', 'precio'],
    ['cuanto sale una app para mi tienda', 'precio'],
    ['Me pueden pasar una cotización?', 'precio'],
    ['qué precio tiene el sistema de inventario', 'precio'],
    ['y eso es caro?', 'precio'],
    ['CUÁNTO COBRAN por una página web', 'precio'],
    ['¿Cuánto se tardan?', 'plazo'],
    ['en cuanto tiempo me lo entregan', 'plazo'],
    ['cuál es el tiempo de entrega', 'plazo'],
    ['para cuándo estaría listo?', 'plazo'],
    ['¿A qué hora atienden?', 'horario'],
    ['cual es su horario', 'horario'],
    ['atienden los sábados?', 'horario'],
    ['aceptan Zelle?', 'pagos'],
    ['cuáles son las formas de pago', 'pagos'],
    ['se puede pagar en cuotas?', 'financiamiento'],
    ['Quiero una reunión', 'reunion'],
    ['me pueden llamar mañana?', 'reunion'],
    ['podemos hacer una videollamada', 'reunion'],
    ['quisiera ver una demo', 'reunion'],
    ['Ustedes usan React o Angular?', 'tecnologia'],
    ['qué lenguaje usan', 'tecnologia'],
    ['trabajan con Laravel?', 'tecnologia'],
    ['¿saben Odoo?', 'tecnologia'],
  ];
  // Según la acción de la intención: "responder" (horario, pagos) contesta con UNA pregunta y no deriva;
  // "precios" sin servicio pregunta cuál; con servicio y "derivar" el mensaje fijo deriva sin preguntas.
  for (const [text, intent] of positives) {
    test(`detecta: "${text}" → ${intent}`, () => {
      const hit = preGuard(text, rules);
      assert.equal(hit?.intent, intent);
      const accion = rules.pre.intents.find((i) => i.id === intent)?.accion ?? 'derivar';
      if (hit!.motivo === null) {
        assert.ok(accion === 'responder' || accion === 'precios', `${intent} no deriva`);
        assert.equal((hit!.reply.match(/\?/g) ?? []).length, 1, 'una sola pregunta de avance');
      } else {
        assert.notEqual(accion, 'responder');
        assert.ok(hit!.motivo.includes(text.trim()));
        assert.doesNotMatch(hit!.reply, /\?/, 'el mensaje fijo no hace preguntas');
      }
    });
  }

  // Frases reales de diagnóstico que NO deben derivarse.
  const negatives = [
    'Hola, ¿qué hacen?',
    'Tengo una ferretería y llevo todo en Excel',
    'tengo que actualizar los precios de 2000 productos a mano',
    'hago cotizaciones a mano para mis clientes',
    'pierdo mucho tiempo copiando pedidos',
    'los pedidos llegan por WhatsApp y los anotamos en Excel',
    'uso Odoo y WordPress en mi tienda',
    'llevo los horarios de mis empleados en Excel',
    'concilio los pagos móviles a mano',
    'recibo muchas llamadas de clientes',
    'somos 8 personas',
    'Eres una IA?',
    'mis pacientes piden una cita por WhatsApp',
    'necesito un sistema para mi distribuidora',
  ];
  for (const text of negatives) {
    test(`no deriva: "${text}"`, () => {
      assert.equal(preGuard(text, rules), null);
    });
  }
});

describe('postGuard', () => {
  const violations: [string, string][] = [
    ['Atendemos de lunes a viernes, de 9:00 a 18:00.', 'horario'],
    ['Abrimos a las 9am.', 'horario'],
    ['El ERP cuesta desde $500.', 'precio'],
    ['Ronda los 300 dólares.', 'precio'],
    ['Lo tendríamos listo en 2 semanas.', 'plazo'],
    ['Suele tomar un mes.', 'plazo'],
    ['Trabajamos con Angular y Node.', 'tecnologia'],
    ['¿Qué negocio tienes? ¿Cuántos son en el equipo?', 'preguntas'],
    ['{"name": "transferir_a_humano", "arguments": {"motivo": "precio"}}', 'tool_texto'],
  ];
  for (const [text, violation] of violations) {
    test(`bloquea (${violation}): "${text}"`, () => {
      const r = postGuard(text, rules, knowledge);
      assert.equal(r.ok, false);
      assert.ok(r.violations.includes(violation as never), `esperaba ${violation}, obtuvo ${r.violations.join(',')}`);
    });
  }

  const allowed = [
    'Hacemos software a medida, ERP, apps y automatización con IA. ¿Qué tipo de negocio tienes?',
    'Entiendo, llevar todo en Excel quita mucho tiempo. ¿Cuántas personas trabajan contigo?',
    'Ayudamos a equipos de 5 a 10 personas a ordenar sus pedidos de WhatsApp.',
    'Estamos en Caracas, Venezuela. Una persona del equipo te escribirá por aquí.',
  ];
  for (const text of allowed) {
    test(`permite: "${text}"`, () => {
      const r = postGuard(text, rules, knowledge);
      assert.deepEqual(r.violations, []);
      assert.equal(r.ok, true);
    });
  }

  test('corrige Markdown sin bloquear', () => {
    const r = postGuard('**Hola**, somos DevBull.', rules, knowledge);
    assert.equal(r.ok, true);
    assert.equal(r.text, '*Hola*, somos DevBull.');
  });

  test('keepOneQuestion deja solo la última pregunta y conserva el resto', () => {
    assert.equal(keepOneQuestion('Entiendo. ¿Cuántos son? Por ejemplo, ¿usan Excel?'), 'Entiendo. ¿Cuántos son?');
    assert.equal(
      keepOneQuestion('Buen día. Entiendo que buscar facturas es difícil, ¿cierto? Podemos digitalizarlas con un sistema. ¿Cuántas personas las manejan?'),
      'Buen día. Entiendo que buscar facturas es difícil. Podemos digitalizarlas con un sistema. ¿Cuántas personas las manejan?',
    );
    assert.equal(keepOneQuestion('Solo una. ¿Cuántos son?'), 'Solo una. ¿Cuántos son?');
  });
});

describe('parseRules', () => {
  test('falla claro si reglas.json está mal editado', () => {
    assert.throws(() => parseRules('{ no es json'), RulesError);
    assert.throws(() => parseRules('{"pre":{"intents":[{"id":"x"}]},"post":{}}'), /motivo/);
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

const base = { businessName: 'DevBull', knowledgePath: 'knowledge/negocio.md', rules };

describe('runAgent con guards', () => {
  test('el control previo responde y deriva sin consultar al modelo', async () => {
    const { llm, requests } = scripted([]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: '¿Cuánto cuesta un ERP?' }] });
    assert.equal(r.source, 'guard-pre');
    assert.equal(requests.length, 0);
    assert.match(r.handoff?.motivo ?? '', /precio/i);
    assert.equal(r.guardEvents[0]?.stage, 'pre');
  });

  test('si el modelo inventa un horario, reintenta con instrucción correctiva', async () => {
    const { llm, requests } = scripted([
      { text: 'Atendemos de lunes a viernes de 9:00 a 18:00.' },
      { text: 'Hacemos software a medida y automatización. ¿Qué tipo de negocio tienes?' },
    ]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: 'Hola, ¿qué hacen?' }] });
    assert.equal(r.source, 'guard-post-retry');
    assert.equal(requests.length, 2);
    assert.match(requests[1]!.system.at(-1)!.text, /CORRECCIÓN OBLIGATORIA.*horario/);
    assert.equal(r.guardEvents[0]?.action, 'retry');
  });

  test('si falla dos veces, usa el mensaje seguro y deriva', async () => {
    const { llm } = scripted([{ text: 'Cuesta $500.' }, { text: 'Unos 300 dólares.' }]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: 'Hola, ¿qué hacen?' }] });
    assert.equal(r.source, 'guard-post-fallback');
    assert.equal(r.reply, rules.post.respuestaSegura);
    assert.match(r.handoff?.motivo ?? '', /bloqueada.*precio/);
    assert.deepEqual(r.guardEvents.map((e) => e.action), ['retry', 'fallback']);
  });

  test('si solo pregunta de más, se corrige SIN reintentar al modelo', async () => {
    const { llm, requests } = scripted([{ text: 'Genial. ¿Qué vendes? ¿Dónde?' }]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: 'Hola' }] });
    assert.equal(r.source, 'guard-post-fixed');
    assert.equal(r.reply, 'Genial. ¿Qué vendes?');
    assert.equal(requests.length, 1, 'sin reintento');
    assert.equal(r.handoff, null);
  });

  test('una respuesta correcta pasa sin tocar', async () => {
    const { llm } = scripted([{ text: 'Somos DevBull: software a medida, ERP y automatización. ¿Qué tipo de negocio tienes?' }]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: 'Hola, ¿qué hacen?' }] });
    assert.equal(r.source, 'model');
    assert.deepEqual(r.guardEvents, []);
  });
});

describe('postGuard: voseo (negocio.md pide tuteo)', () => {
  for (const text of ['Entiendo que tenés una distribuidora.', 'Los pedidos los anotáis en Excel.', '¿A qué negocio pertenecés?', 'Contame más de tu negocio.']) {
    test(`bloquea: "${text}"`, () => {
      const r = postGuard(text, rules, knowledge);
      assert.ok(r.violations.includes('voseo'), r.details.join(' | '));
    });
  }
  for (const text of ['¿Usas Excel para todo?', 'Entiendo que tienes una distribuidora.', 'Llevas el inventario a mano, ¿verdad?', 'Cuéntame más de tu negocio.']) {
    test(`permite tuteo: "${text}"`, () => {
      assert.ok(!postGuard(text, rules, knowledge).violations.includes('voseo'));
    });
  }
});

describe('runAgent: respuesta vacía', () => {
  test('si el modelo no devuelve texto, reintenta y usa la respuesta buena', async () => {
    const { llm, requests } = scripted([
      { text: '', stopReason: 'max_tokens' },
      { text: 'Somos DevBull: software a medida y automatización. ¿Qué tipo de negocio tienes?' },
    ]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: 'Hola, ¿qué hacen?' }] });
    assert.equal(r.source, 'guard-post-retry');
    assert.match(r.reply ?? '', /DevBull/);
    assert.match(requests[1]!.system.at(-1)!.text, /quedó vacía/);
  });

  test('si vuelve a salir vacía, nunca deja al cliente sin respuesta: mensaje seguro + handoff', async () => {
    const { llm } = scripted([{ text: '', stopReason: 'max_tokens' }, { text: '', stopReason: 'max_tokens' }]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: 'Hola' }] });
    assert.equal(r.source, 'guard-post-fallback');
    assert.equal(r.reply, rules.post.respuestaSegura);
    assert.ok(r.handoff);
  });
});
