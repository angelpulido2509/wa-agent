import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { buildSystem, runAgent } from '../src/agent.js';
import { fixGreeting, keepOneQuestion, postGuard, stripInventedSentences } from '../src/guards/post.js';
import { parseRules } from '../src/guards/rules.js';
import { parseBusinessRules } from '../src/guards/negocio.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/llm/types.js';
import { greetingMismatch, INVENTED_EXPERIENCE, OFFER_BY_SECTOR } from '../src/scenario-checks.js';

// Frases propias de este archivo: no repiten textos de los escenarios ni del set held-out.
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

describe('1. validador alineado con el guard (público objetivo)', () => {
  test('"ayudamos a negocios como el tuyo" es válido; rubros concretos y clientes no', () => {
    assert.equal(INVENTED_EXPERIENCE.test('En DevBull ayudamos a negocios como el tuyo a ordenar su operación.'), false);
    assert.equal(INVENTED_EXPERIENCE.test('Ayudamos a empresas y emprendimientos con procesos manuales.'), false);
    assert.equal(INVENTED_EXPERIENCE.test('Ayudamos a panaderías del centro con su facturación.'), true);
    assert.equal(INVENTED_EXPERIENCE.test('Hemos trabajado con varios comercios de la zona.'), true);
  });
});

describe('2. oferta por rubro', () => {
  const blocked = [
    'Diseñamos aplicaciones a medida para farmacias.',
    'Contamos con soluciones listas para talleres mecánicos.',
    'Ofrecemos un sistema de reservas para hoteles.',
  ];
  for (const text of blocked) {
    test(`guard bloquea: "${text}"`, () => assert.ok(postGuard(text, rules, knowledge).violations.includes('oferta_rubro')));
  }
  const allowed = [
    'Podemos crear un sistema para tu negocio.',
    'Creamos una app para tu farmacia que ordene el inventario.',
    'Creamos software a medida. Muchas farmacias llevan el inventario en papel.',
    'Atendemos a empresas y emprendimientos con procesos manuales.',
  ];
  for (const text of allowed) {
    test(`guard permite: "${text}"`, () => assert.ok(!postGuard(text, rules, knowledge).violations.includes('oferta_rubro')));
  }

  test('el validador de escenarios detecta la oferta por rubro en la misma oración', () => {
    assert.ok(OFFER_BY_SECTOR.test('Hacemos plataformas de pedidos para pizzerías.'));
    assert.ok(!OFFER_BY_SECTOR.test('Hacemos plataformas a medida. Las pizzerías reciben muchos pedidos.'));
  });

  test('el prompt pide no ofrecer por rubro (sin nombrar rubros de los tests)', () => {
    const stable = buildSystem('DevBull', knowledge, new Date(), 'detailed')[0]!.text;
    assert.match(stable, /No ofrezcas productos o servicios por rubro/);
    assert.match(stable, /"tu negocio"/);
  });

  test('si el modelo insiste, se borra solo la oración con la oferta por rubro', async () => {
    const draft = 'Diseñamos aplicaciones a medida para farmacias. Podemos digitalizar el control de tu inventario con un sistema. ¿Cuántas personas trabajan contigo?';
    const { llm } = scripted([{ text: draft }, { text: draft }]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: 'tengo una farmacia y el inventario lo llevo en papel' }] });
    assert.equal(r.source, 'guard-post-fixed');
    assert.equal(r.reply, 'Podemos digitalizar el control de tu inventario con un sistema. ¿Cuántas personas trabajan contigo?');
    assert.equal(r.handoff, null);
  });
});

describe('3. el motivo del mensaje seguro refleja el ÚLTIMO borrador', () => {
  test('primer borrador: horario inventado; segundo: voseo → el motivo dice voseo', async () => {
    const { llm } = scripted([{ text: 'Atendemos de lunes a viernes. ¿Qué vendes?' }, { text: 'Tenés razón, contame más. ¿Cuántos son?' }]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: 'Hola' }] });
    assert.equal(r.source, 'guard-post-fallback');
    assert.match(r.handoff?.motivo ?? '', /\(voseo\)/);
    assert.doesNotMatch(r.handoff?.motivo ?? '', /horario/);
  });
});

describe('4. recorte de preguntas sin perder la parte informativa', () => {
  test('quita el conector suelto "Por ejemplo," de la pregunta que queda', () => {
    assert.equal(
      keepOneQuestion('Somos DevBull y digitalizamos procesos, ¿te suena? Por ejemplo, ¿qué tipo de negocio tienes?'),
      'Somos DevBull y digitalizamos procesos. ¿Qué tipo de negocio tienes?',
    );
  });

  test('si quedarse con la última pierde la presentación de DevBull, conserva la que informa', () => {
    assert.equal(
      keepOneQuestion('¡Hola! ¿Sabías que en DevBull automatizamos tareas repetitivas? Por ejemplo, ¿qué vendes?'),
      '¡Hola! ¿Sabías que en DevBull automatizamos tareas repetitivas?',
    );
  });

  test('no recorta letras de palabras que empiezan como un conector ("Ofrecemos")', () => {
    assert.equal(
      keepOneQuestion('Ofrecemos software a medida. ¿Te interesa? ¿Cuántos son?'),
      'Ofrecemos software a medida. ¿Cuántos son?',
    );
  });
});

describe('5. experiencia inventada en una pregunta que negocio.md cubre (IA)', () => {
  test('borra solo la oración inventada en vez de mandar el mensaje seguro', async () => {
    const draft = 'Con IA hemos ayudado a muchos negocios. Usamos asistentes y análisis de datos para automatizar tareas repetitivas. ¿Qué área te gustaría mejorar?';
    const { llm } = scripted([{ text: draft }, { text: draft }]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: '¿y qué ofrecen con IA?' }] });
    assert.equal(r.source, 'guard-post-fixed');
    assert.equal(r.reply, 'Usamos asistentes y análisis de datos para automatizar tareas repetitivas. ¿Qué área te gustaría mejorar?');
    assert.equal(r.handoff, null);
  });

  test('una combinación repartida en dos oraciones no es experiencia inventada', () => {
    const text = 'En DevBull ayudamos a ordenar procesos manuales. Muchos equipos pierden tiempo con hojas sueltas.';
    assert.ok(!postGuard(text, rules, knowledge).violations.includes('experiencia'));
    assert.equal(stripInventedSentences(text, rules), text);
  });
});

describe('6. saludo', () => {
  test('respeta el saludo horario del cliente', () => {
    assert.equal(fixGreeting('¡Buenos días! Entiendo tu caso.', 'Hola buenas tardes, quería consultar'), '¡Buenas tardes! Entiendo tu caso.');
    assert.equal(fixGreeting('Buenas días, entiendo.', 'buenas noches'), 'Buenas noches, entiendo.');
  });

  test('si el cliente no dio uno, usa un saludo neutro; sin saludo horario no cambia nada', () => {
    assert.equal(fixGreeting('Buenos días. Somos DevBull.', 'hola, info'), 'Hola. Somos DevBull.');
    assert.equal(fixGreeting('¡Hola! Somos DevBull.', 'buenas tardes'), '¡Hola! Somos DevBull.');
  });

  test('el validador marca saludos que contradicen o adivinan la hora', () => {
    assert.match(greetingMismatch('Buenos días, ¿cómo estás?', 'buenas noches') ?? '', /distinto/);
    assert.match(greetingMismatch('Buenas tardes. Somos DevBull.', 'hola') ?? '', /no pedido/);
    assert.equal(greetingMismatch('Buenas tardes. Somos DevBull.', 'Hola, buenas tardes'), null);
  });

  test('runAgent aplica el saludo del cliente a la respuesta del modelo', async () => {
    const { llm } = scripted([{ text: 'Buenos días. En DevBull digitalizamos procesos manuales. ¿Qué tipo de negocio tienes?' }]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: 'buenas noches, quería información' }] });
    assert.match(r.reply ?? '', /^Buenas noches\./);
  });
});
