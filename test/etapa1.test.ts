import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { buildSystem, runAgent } from '../src/agent.js';
import { customerSummary, reviewHandoff, unsupportedConcepts } from '../src/guards/handoff.js';
import { fixBold, keepOneQuestion, postGuard, questionScore, stripInventedSentences } from '../src/guards/post.js';
import { parseRules } from '../src/guards/rules.js';
import { parseBusinessRules } from '../src/guards/negocio.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/llm/types.js';
import { OFFER_BY_SECTOR, PROMISED_FEATURES } from '../src/scenario-checks.js';

// Frases propias de este archivo: no repiten textos de escenarios, held-out ni heldout2.
const rules = parseBusinessRules(fs.readFileSync('knowledge/reglas.json', 'utf8'), fs.readFileSync('knowledge/negocio.md', 'utf8'));
const knowledge = fs.readFileSync('knowledge/negocio.md', 'utf8');

function scripted(responses: Partial<LlmResponse>[]) {
  const requests: LlmRequest[] = [];
  const llm: LlmProvider = {
    name: 'openai-compatible',
    model: 'fake',
    async chat(req) {
      requests.push(structuredClone(req));
      const next = responses.shift();
      if (!next) throw new Error('sin más respuestas');
      return { text: '', toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 1 }, ...next };
    },
  };
  return { llm, requests };
}
const base = { businessName: 'DevBull', knowledgePath: 'knowledge/negocio.md', rules };
const handoffCall = (motivo: string) => ({ toolCalls: [{ id: 'c1', name: 'transferir_a_humano', input: { motivo } }], stopReason: 'tool_use' as const });

describe('E1.1 dos preguntas: corrección sin reintento, conservando la que se entiende sola', () => {
  test('puntaje: la pregunta abierta completa gana a la de opciones o dependiente', () => {
    assert.ok(questionScore('¿Qué tipo de negocio tienes?') > questionScore('¿Es una tienda, un taller o algo más?'));
    assert.ok(questionScore('¿Cuántos son en el equipo?') > questionScore('¿Y qué venden?'));
  });

  test('una sola llamada al modelo; queda la pregunta que se entiende sola', async () => {
    const { llm, requests } = scripted([{ text: 'Te ayudo con gusto 🙌 ¿Es una tienda, un taller o algo más? ¿Qué tipo de negocio tienes?' }]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: 'buenas, una consulta' }] });
    assert.equal(requests.length, 1);
    assert.equal(r.source, 'guard-post-fixed');
    assert.equal(r.reply, 'Te ayudo con gusto 🙌 ¿Qué tipo de negocio tienes?');
  });

  test('si además falla otra cosa, sí reintenta', async () => {
    const { llm, requests } = scripted([
      { text: 'Atendemos de lunes a viernes. ¿Qué vendes? ¿Dónde?' },
      { text: 'Con gusto te ayudo. ¿Qué tipo de negocio tienes?' },
    ]);
    await runAgent({ ...base, llm, history: [{ role: 'user', text: 'buenas, una consulta' }] });
    assert.equal(requests.length, 2);
  });

  test('keepOneQuestion no deja una pregunta de opciones sin contexto', () => {
    assert.equal(
      keepOneQuestion('¿Qué tipo de negocio tienes? ¿Es una tienda, restaurante, taller o algo más? Así entiendo mejor.'),
      '¿Qué tipo de negocio tienes? Así entiendo mejor.',
    );
  });
});

describe('E1.2 oferta por rubro también sin verbo', () => {
  for (const text of ['Un sistema de reservas para hoteles te ahorraría tiempo.', 'La plataforma ideal para talleres es simple de usar.', 'Hay soluciones para gimnasios muy completas.']) {
    test(`bloquea: "${text}"`, () => assert.ok(postGuard(text, rules, knowledge).violations.includes('oferta_rubro')));
  }
  for (const text of ['Una app para tu hotel podría ordenar las reservas.', 'Un sistema para tu negocio te ahorraría tiempo.', 'Atendemos a empresas y emprendimientos.']) {
    test(`permite: "${text}"`, () => assert.ok(!postGuard(text, rules, knowledge).violations.includes('oferta_rubro')));
  }
  test('el validador de escenarios también detecta la forma sin verbo', () => {
    assert.ok(OFFER_BY_SECTOR.test('Un sistema de reservas para hoteles.'));
    assert.ok(!OFFER_BY_SECTOR.test('Un sistema para tu hotel.'));
  });
});

describe('E1.3 "nombrar un servicio" también cuando preguntan qué hace DevBull', () => {
  const first = (customerText: string) => ({ firstContact: true, customerText });
  test('primer mensaje "¿a qué se dedican?" sin servicio → sin_servicio', () => {
    assert.ok(postGuard('¡Hola! Cuéntame qué necesitas 😊', rules, knowledge, first('hola, ¿a qué se dedican?')).violations.includes('sin_servicio'));
  });
  test('con un servicio nombrado pasa; y no aplica fuera del primer mensaje', () => {
    assert.ok(postGuard('Hacemos software a medida y automatización. ¿Qué necesitas?', rules, knowledge, first('quisiera información')).ok);
    assert.ok(postGuard('¡Claro! ¿Qué necesitas?', rules, knowledge, { firstContact: false, customerText: 'mas info' }).ok);
  });
});

describe('E1.4 funciones prometidas que no están en negocio.md', () => {
  test('bloquea promesas concretas y el validador también las detecta', () => {
    const text = 'Además te enviamos alertas por correo electrónico cada semana.';
    assert.ok(postGuard(text, rules, knowledge).violations.includes('funcion_prometida'));
    assert.ok(PROMISED_FEATURES.test(text));
  });
  test('hablar en general (automatizar, centralizar) está permitido', () => {
    assert.ok(postGuard('Podemos automatizar y centralizar ese proceso.', rules, knowledge).ok);
  });
  test('si la función sí está en negocio.md, se permite', () => {
    const conCorreo = `${knowledge}\n- Envío de reportes por correo a los clientes.`;
    assert.ok(!postGuard('Te mandamos el resumen por correo.', rules, conCorreo).violations.includes('funcion_prometida'));
  });
  test('si el modelo insiste, se borra solo esa oración', async () => {
    const draft = 'Podemos digitalizar tu control de pedidos con un sistema. Además se integra con tu banco para cobrar solo. ¿Cuántas personas trabajan contigo?';
    const { llm } = scripted([{ text: draft }, { text: draft }]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: 'tengo una venta de repuestos y llevo los pedidos en una libreta' }] });
    assert.equal(r.reply, 'Podemos digitalizar tu control de pedidos con un sistema. ¿Cuántas personas trabajan contigo?');
    assert.equal(stripInventedSentences(draft, rules, knowledge), r.reply);
  });
  test('el prompt lo indica en general', () => {
    assert.match(buildSystem('DevBull', knowledge, new Date(), 'detailed')[0]!.text, /No prometas funciones específicas/);
  });
});

describe('E1.5 formato: saludo sin negrita, máximo 2 negritas, nunca un párrafo', () => {
  test('saludo en negrita → texto normal', () => {
    assert.equal(fixBold('*¡Hola, buen día!* Con gusto te ayudo.'), '¡Hola, buen día! Con gusto te ayudo.');
  });
  test('oración o párrafo entero en negrita → texto normal', () => {
    assert.equal(fixBold('*Entiendo tu situación. Vamos a revisarla con calma.*'), 'Entiendo tu situación. Vamos a revisarla con calma.');
  });
  test('más de dos negritas → solo las dos primeras se mantienen', () => {
    assert.equal(fixBold('Puede ser *web*, *móvil*, *ERP* o *IA*.'), 'Puede ser *web*, *móvil*, ERP o IA.');
  });
  test('runAgent lo aplica antes de enviar', async () => {
    const { llm } = scripted([{ text: '*Hola!* En DevBull hacemos *software*, *apps* y *automatización*. ¿Qué tipo de negocio tienes?' }]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: 'hola' }] });
    assert.equal(r.reply, 'Hola! En DevBull hacemos *software*, *apps* y automatización. ¿Qué tipo de negocio tienes?');
  });
});

describe('E1.6 el motivo del handoff solo usa hechos que escribió el cliente', () => {
  const texts = ['Quisiera ordenar mi negocio', 'una venta de repuestos', 'somos 6', 'los pedidos los anoto en una libreta'];
  test('detecta conceptos agregados por el bot', () => {
    assert.deepEqual(unsupportedConcepts('Venta de repuestos, 6 personas, pedidos en libreta; necesita facturación', texts), ['facturacion']);
    assert.deepEqual(unsupportedConcepts('Venta de repuestos de 6 personas; pedidos anotados en libreta', texts), []);
  });
  test('reescribe con lo que dijo el cliente', () => {
    const d = reviewHandoff('Venta de repuestos de 6 personas; necesita controlar facturación y nómina', {
      firstContact: false,
      customerTexts: texts,
      lastCustomerText: texts.at(-1)!,
      rules,
    });
    assert.equal(d.allow, true);
    assert.equal(d.motivo, customerSummary(texts));
    assert.match(d.note ?? '', /facturacion/);
  });
  test('runAgent: handoff en un turno posterior con un concepto agregado', async () => {
    const { llm } = scripted([handoffCall('Repuestos, 6 personas, quiere un sistema de nómina'), { text: 'Listo, una persona del equipo te escribirá por aquí.' }]);
    const r = await runAgent({
      ...base,
      llm,
      history: [
        { role: 'user', text: 'tengo una venta de repuestos' },
        { role: 'bot', text: 'Entiendo. Podemos digitalizarlo con un sistema. ¿Cuántas personas son?' },
        { role: 'user', text: 'somos 6' },
      ],
    });
    assert.equal(r.handoff?.motivo, customerSummary(['tengo una venta de repuestos', 'somos 6']));
  });
});

describe('E1.7 acotaciones escénicas prohibidas en el prompt (conversión a emoji = red de seguridad)', () => {
  test('ambas variantes del prompt lo prohíben', () => {
    assert.match(buildSystem('DevBull', knowledge, new Date(), 'detailed')[0]!.text, /acotaciones escénicas/);
    assert.match(buildSystem('DevBull', knowledge, new Date(), 'compact')[0]!.text, /Nada de acotaciones entre asteriscos/);
  });
});
