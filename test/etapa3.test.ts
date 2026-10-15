import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { buildSystem, runAgent } from '../src/agent.js';
import { hourViolation, parseAmount, paymentViolation, priceViolation } from '../src/guards/datos.js';
import { isOffHours, offHoursNotice } from '../src/guards/horario.js';
import { postGuard } from '../src/guards/post.js';
import { preGuard } from '../src/guards/pre.js';
import { detectServicios } from '../src/guards/precios.js';
import { parseRules, RulesError } from '../src/guards/rules.js';
import { parseBusinessRules } from '../src/guards/negocio.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/llm/types.js';
import { businessFacts, inventedData } from '../src/scenario-checks.js';

// Frases propias de este archivo: no repiten textos de escenarios, held-out ni heldout2.
const raw = fs.readFileSync('knowledge/reglas.json', 'utf8');
const rules = parseBusinessRules(raw, fs.readFileSync('knowledge/negocio.md', 'utf8'));
const knowledge = fs.readFileSync('knowledge/negocio.md', 'utf8');
const precios = rules.precios!;
const horario = rules.horario!;

/** 10:00 y 23:00 en Caracas (UTC−4). */
const DAY = new Date('2026-10-14T14:00:00Z');
const NIGHT = new Date('2026-10-15T03:00:00Z');
const EARLY = new Date('2026-10-14T10:30:00Z'); // 6:30 am

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
const noModel = scripted([]).llm;
const base = { businessName: 'DevBull', knowledgePath: 'knowledge/negocio.md', rules, now: DAY };

describe('E3.c precios: rango por servicio detectado + handoff', () => {
  const casos: [string, string, RegExp][] = [
    ['cuánto cuesta hacer una landing para mi marca', 'web', /100 a 600 USD/],
    ['qué precio tiene un sistema web para mi empresa', 'app_web', /300 a 2500 USD/],
    ['cuánto me cobran por una app móvil', 'app_movil', /500 a 3000 USD/],
    ['cuánto sale un sistema de facturación', 'erp', /300 a 900 USD/],
    ['cuanto cuesta un chatbot para mi tienda', 'whatsapp', /desde 100 USD, con una mensualidad variable que se define en el diagnóstico/],
    ['precio de un asistente con inteligencia artificial?', 'ia', /80 a 250 USD/],
  ];
  for (const [text, id, rango] of casos) {
    test(`${id}: "${text}"`, async () => {
      const r = await runAgent({ ...base, llm: noModel, history: [{ role: 'user', text }] });
      assert.equal(r.source, 'guard-pre');
      assert.match(r.reply!, rango);
      assert.match(r.reply!, /Es un rango referencial y el precio final depende del diagnóstico, que es gratis\./);
      assert.doesNotMatch(r.reply!, /\?/);
      assert.ok(r.handoff, 'deriva a una persona');
      assert.deepEqual(detectServicios(text, precios).map((d) => d.servicio.id), [id]);
    });
  }

  test('la automatización de WhatsApp no publica tope ni monto mensual', () => {
    const hit = preGuard('cuánto cuesta automatizar el whatsapp de mi tienda', rules)!;
    assert.match(hit.reply, /desde 100 USD, con una mensualidad variable/);
    assert.doesNotMatch(hit.reply, /\d+\s*(USD)?\s*(al mes|mensual)|tope|hasta \d/i);
  });

  test('varios servicios → los lista todos', () => {
    const hit = preGuard('cuánto cuesta una página web y un ERP?', rules)!;
    assert.match(hit.reply, /- Página web \/ landing: de 100 a 600 USD\n- ERP \/ sistemas de facturación: de 300 a 900 USD/);
    assert.ok(hit.motivo);
  });

  test('"app" sola es ambigua → rangos de app web y app móvil', () => {
    const hit = preGuard('¿cuánto vale una app para mi delivery?', rules)!;
    assert.match(hit.reply, /App web a medida: de 300 a 2500 USD/);
    assert.match(hit.reply, /App móvil: de 500 a 3000 USD/);
  });

  test('la frase más larga gana: "app web" no es también página web ni app móvil', () => {
    assert.deepEqual(detectServicios('una app web', precios).map((d) => d.servicio.id), ['app_web']);
    assert.deepEqual(detectServicios('automatizacion de whatsapp', precios).map((d) => d.servicio.id), ['whatsapp']);
  });

  test('sin servicio → UNA pregunta fija, sin handoff y sin modelo', async () => {
    const r = await runAgent({ ...base, llm: noModel, history: [{ role: 'user', text: '¿cuánto me sale?' }] });
    assert.equal(r.reply, precios.preguntaSinServicio);
    assert.equal(r.handoff, null);
    assert.equal(r.source, 'guard-pre');
  });

  test('respuesta a la pregunta de servicio → rango + handoff', async () => {
    const r = await runAgent({
      ...base,
      llm: noModel,
      history: [
        { role: 'user', text: 'cuánto cobran?' },
        { role: 'bot', text: precios.preguntaSinServicio },
        { role: 'user', text: 'una app móvil para mis clientes' },
      ],
    });
    assert.match(r.reply!, /500 a 3000 USD/);
    assert.ok(r.handoff);
    assert.match(r.handoff!.motivo, /«cuánto cobran\?» · «una app móvil para mis clientes»/);
  });

  test('respuesta a la pregunta sin servicio reconocible → deriva sin inventar rango', async () => {
    const r = await runAgent({
      ...base,
      llm: noModel,
      history: [
        { role: 'user', text: 'cuánto cobran?' },
        { role: 'bot', text: precios.preguntaSinServicio },
        { role: 'user', text: 'algo para organizar mi negocio' },
      ],
    });
    assert.equal(r.reply, precios.sinServicioTrasPregunta);
    assert.doesNotMatch(r.reply!, /\d/);
    assert.ok(r.handoff);
  });

  test('"¿cuánto me sale?" después de nombrar el servicio en un mensaje anterior', async () => {
    const r = await runAgent({
      ...base,
      llm: noModel,
      history: [
        { role: 'user', text: 'quiero una tienda online para vender ropa' },
        { role: 'bot', text: 'Podemos ayudarte con una página web. ¿Ya tienes catálogo?' },
        { role: 'user', text: 'y cuánto me sale?' },
      ],
    });
    assert.match(r.reply!, /100 a 600 USD/);
    assert.match(r.handoff!.motivo, /«tienda online»/);
  });

  test('pedir que le hagan un producto concreto → rango + handoff; sin producto reconocible → sigue al modelo', () => {
    const hit = preGuard('¿me podrían hacer una página para mi consultorio?', rules)!;
    assert.equal(hit.intent, 'encargo');
    assert.match(hit.reply, /100 a 600 USD/);
    assert.equal(preGuard('me pueden hacer un sistema para mi negocio?', rules), null);
  });
});

describe('E3.c motivo fiel', () => {
  test('cita las palabras del cliente y el rango que se le dio', () => {
    const hit = preGuard('epa, cuánto sale una página web sencilla?', rules)!;
    assert.equal(hit.motivo, 'Pide precio («pagina web»). Se le dio el rango referencial de Página web / landing: «epa, cuánto sale una página web sencilla?»');
  });
  test('no le atribuye cotización a quien pidió que le hagan algo', () => {
    const hit = preGuard('me pueden hacer una app para mi gimnasio?', rules)!;
    assert.doesNotMatch(hit.motivo!, /^Pide precio|cotiza/);
    assert.match(hit.motivo!, /«me pueden hacer una app para mi gimnasio\?»/);
  });
});

describe('E3.d post-guard: cifras, horas y pagos solo de la tabla/negocio.md', () => {
  test('rangos completos de la tabla: permitidos', () => {
    assert.equal(priceViolation('Una app móvil va de 500 a 3000 USD, es un rango referencial.', rules), null);
    assert.equal(priceViolation('La automatización de WhatsApp es desde 100 USD, con una mensualidad variable.', rules), null);
    assert.equal(priceViolation('Una app web va de $300 a $2.500.', rules), null);
  });
  const malos: [string, RegExp][] = [
    ['La automatización tiene una mensualidad de 40 USD.', /mensualidad/],
    ['Son 100 USD y luego 25 $ al mes.', /mensualidad/],
    ['El tope es de 900 dólares.', /tope/],
    ['Un ERP cuesta unos 450 USD.', /fuera de la tabla/],
    ['Ronda los 600 dólares.', /cifra suelta/],
    ['El ERP cuesta de 500 a 3000 USD.', /otro servicio/],
    ['Sale en 15.000 bolívares.', /moneda|fuera/],
    ['Cuesta 2 mil dólares.', /mil/],
  ];
  for (const [text, re] of malos) {
    test(`bloquea: "${text}"`, () => {
      assert.match(priceViolation(text, rules) ?? '', re);
      assert.ok(postGuard(text, rules, knowledge).violations.includes('precio'));
    });
  }
  test('horario real permitido; otros horarios bloqueados', () => {
    assert.equal(hourViolation('Atendemos todos los días de 8:00 am a 9:00 pm.', rules), null);
    assert.equal(hourViolation('Te escribimos a partir de las 8 am.', rules), null);
    for (const text of ['Atendemos de lunes a viernes.', 'Abrimos a las 7:00 am.', 'Cerramos a las 6 pm.', 'Estamos 24/7.', 'de 9:00 a 18:00']) {
      assert.ok(hourViolation(text, rules), text);
    }
  });
  test('formas de pago: solo las de la lista', () => {
    assert.equal(paymentViolation('Aceptamos Zelle, Binance (USDT o USDC), pago móvil o transferencia.', rules), null);
    assert.equal(paymentViolation('Puedes pagar con PayPal o tarjeta.', rules), 'paypal');
    assert.ok(postGuard('También aceptamos pagos con tarjeta de crédito.', rules, knowledge).violations.includes('pago'));
  });
  test('montos con separador de miles', () => {
    assert.equal(parseAmount('2.500'), 2500);
    assert.equal(parseAmount('2,500'), 2500);
    assert.equal(parseAmount('100.00'), 100);
  });

  test('el modelo inventa una mensualidad dos veces → mensaje seguro + handoff', async () => {
    const { llm, requests } = scripted([
      { text: 'La automatización arranca en 100 USD y la mensualidad es de 30 USD. ¿Cuántos mensajes recibes al día?' },
      { text: 'Son 100 USD más 30 USD al mes. ¿Te interesa?' },
    ]);
    const r = await runAgent({
      ...base,
      llm,
      history: [
        { role: 'user', text: 'tengo una ferretería y me escriben muchos clientes' },
        { role: 'bot', text: 'Entiendo. Podemos automatizar la atención. ¿Cuántos mensajes recibes?' },
        { role: 'user', text: 'como 80 al día' },
      ],
    });
    assert.equal(requests.length, 2);
    assert.match(requests[1]!.system.at(-1)!.text, /mensualidad o tope/);
    assert.equal(r.source, 'guard-post-fallback');
    assert.doesNotMatch(r.reply!, /30/);
  });

  test('el modelo inventa un tope → reintento; el segundo borrador con el rango real pasa', async () => {
    const { llm } = scripted([
      { text: 'La automatización cuesta desde 100 USD con un tope de 300 USD.' },
      { text: 'La automatización de WhatsApp es desde 100 USD, con una mensualidad variable que se define en el diagnóstico.' },
    ]);
    const r = await runAgent({
      ...base,
      llm,
      history: [
        { role: 'user', text: 'tengo una ferretería y me escriben muchos clientes' },
        { role: 'bot', text: 'Entiendo. Podemos automatizar la atención. ¿Cuántos mensajes recibes?' },
        { role: 'user', text: 'como 80 al día' },
      ],
    });
    assert.equal(r.source, 'guard-post-retry');
    assert.match(r.reply!, /desde 100 USD/);
  });
});

describe('E3.b horario, pagos y reunión gratis: respuesta fija + UNA pregunta, sin handoff', () => {
  const casos: [string, string, RegExp][] = [
    ['¿hasta qué hora atienden?', 'horario', /todos los días de 8:00 am a 9:00 pm/],
    ['¿trabajan los domingos?', 'horario', /todos los días/],
    ['¿qué métodos de pago tienen?', 'pagos', /efectivo en divisas, Zelle, Binance \(USDT o USDC\), pago móvil o transferencia/],
    ['¿aceptan pago móvil?', 'pagos', /pago móvil/],
    ['¿la reunión es gratis?', 'reunion_gratis', /primera reunión de diagnóstico es gratis/],
    ['¿cuánto cuesta la reunión de diagnóstico?', 'reunion_gratis', /gratis/],
  ];
  for (const [text, intent, re] of casos) {
    test(`${intent}: "${text}"`, async () => {
      const r = await runAgent({ ...base, llm: noModel, history: [{ role: 'user', text }] });
      assert.equal(r.guardEvents[0]?.detail.split(' ')[0], intent);
      assert.match(r.reply!, re);
      assert.equal((r.reply!.match(/\?/g) ?? []).length, 1);
      assert.equal(r.handoff, null);
    });
  }
  test('agendar la reunión sigue yendo a una persona', () => {
    const hit = preGuard('quiero agendar la reunión para el jueves', rules)!;
    assert.equal(hit.intent, 'reunion');
    assert.ok(hit.motivo);
  });
  test('cuotas o financiamiento (no confirmado) va a una persona', () => {
    const hit = preGuard('¿lo puedo pagar en cuotas?', rules)!;
    assert.equal(hit.intent, 'financiamiento');
    assert.ok(hit.motivo);
  });
  test('reglas.json: una acción desconocida falla claro', () => {
    const j = JSON.parse(raw);
    j.pre.intents[0].accion = 'inventada';
    assert.throws(() => parseRules(JSON.stringify(j)), RulesError);
  });
});

describe('E3.e fuera de horario: el aviso de handoff dice desde cuándo', () => {
  test('isOffHours: antes de las 8:00 y desde las 21:00 (Caracas)', () => {
    assert.equal(isOffHours(DAY, horario), false);
    assert.equal(isOffHours(NIGHT, horario), true);
    assert.equal(isOffHours(EARLY, horario), true);
    assert.equal(isOffHours(new Date('2026-10-15T00:59:00Z'), horario), false); // 20:59
    assert.equal(isOffHours(new Date('2026-10-15T01:00:00Z'), horario), true); // 21:00
  });
  test('handoff de precio de noche → "a partir de las 8:00 am"', async () => {
    const r = await runAgent({ ...base, now: NIGHT, llm: noModel, history: [{ role: 'user', text: 'cuánto cuesta un ERP' }] });
    assert.match(r.reply!, /te escribirá por aquí a partir de las 8:00 am \(hora de Caracas\)/);
    assert.ok(r.handoff);
  });
  test('de día no cambia', async () => {
    const r = await runAgent({ ...base, llm: noModel, history: [{ role: 'user', text: 'cuánto cuesta un ERP' }] });
    assert.doesNotMatch(r.reply!, /8:00 am/);
  });
  test('sin handoff (horario, pagos) no se agrega aviso', async () => {
    const r = await runAgent({ ...base, now: NIGHT, llm: noModel, history: [{ role: 'user', text: '¿qué métodos de pago tienen?' }] });
    assert.doesNotMatch(r.reply!, /a partir de/);
  });
  test('handoff del modelo de madrugada', async () => {
    const { llm } = scripted([
      { toolCalls: [{ id: 'c1', name: 'transferir_a_humano', input: { motivo: 'Quiere contratar' } }], stopReason: 'tool_use' },
      { text: 'Perfecto. En breve te escriben por aquí 🙌' },
    ]);
    const r = await runAgent({
      ...base,
      now: EARLY,
      llm,
      history: [
        { role: 'user', text: 'tengo una tienda' },
        { role: 'bot', text: 'Genial. ¿Qué te gustaría mejorar?' },
        { role: 'user', text: 'quiero contratar ya' },
      ],
    });
    assert.equal(r.reply, 'Perfecto. Te escriben por aquí a partir de las 8:00 am (hora de Caracas) 🙌');
  });
  test('sin un aviso reconocible, se agrega una oración', () => {
    assert.equal(
      offHoursNotice('Listo, ya lo pasé al equipo.', horario),
      'Listo, ya lo pasé al equipo. Como estamos fuera de horario, una persona del equipo te escribirá a partir de las 8:00 am (hora de Caracas).',
    );
  });
});

describe('E3 prompt y validador independiente', () => {
  test('el prompt permite solo los rangos de la tabla y el horario/pagos escritos', () => {
    const detailed = buildSystem('DevBull', knowledge, DAY, 'detailed')[0]!.text;
    assert.match(detailed, /Lo único que puedes mencionar son los rangos/);
    assert.match(detailed, /mensualidades ni topes/);
    assert.match(buildSystem('DevBull', knowledge, DAY, 'compact')[0]!.text, /solo los rangos referenciales de la tabla/);
  });
  test('el validador de escenarios lee la tabla y el horario de negocio.md', () => {
    const facts = businessFacts(knowledge);
    assert.deepEqual(facts.ranges, [[100, 600], [300, 2500], [500, 3000], [300, 900], [100], [80, 250]]);
    assert.deepEqual([...facts.hours].sort((a, b) => a - b), [8, 21]);
    assert.deepEqual(inventedData(preGuard('cuánto cuesta una página web y un ERP?', rules)!.reply, facts), []);
    assert.deepEqual(inventedData(preGuard('¿hasta qué hora atienden?', rules)!.reply, facts), []);
    assert.equal(inventedData('Un ERP cuesta 450 USD.', facts).length, 1);
    assert.equal(inventedData('La mensualidad es de 20 USD.', facts).length > 0, true);
    assert.equal(inventedData('Atendemos de lunes a viernes de 9:00 am a 5:00 pm.', facts).length, 3);
    assert.equal(inventedData('Aceptamos PayPal.', facts).length, 1);
  });
});
