import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { runAgent } from '../src/agent.js';
import { postGuard } from '../src/guards/post.js';
import { preGuard } from '../src/guards/pre.js';
import { parseRules } from '../src/guards/rules.js';
import { parseBusinessRules } from '../src/guards/negocio.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/llm/types.js';

const rules = parseBusinessRules(fs.readFileSync('knowledge/reglas.json', 'utf8'), fs.readFileSync('knowledge/negocio.md', 'utf8'));
const knowledge = fs.readFileSync('knowledge/negocio.md', 'utf8');

describe('postGuard: experiencia, clientes o casos inventados', () => {
  const invented = [
    'En DevBull justamente ayudamos a restaurantes a automatizar la recepción de pedidos.',
    'Ayudamos a clínicas como la tuya a organizar sus citas.',
    'Hemos trabajado con varias distribuidoras del país.',
    'Nuestros clientes ya no usan Excel.',
    'Tenemos experiencia en el sector salud.',
    'Hemos ayudado a muchos negocios a digitalizarse.',
    'Te puedo contar casos de éxito parecidos.',
  ];
  for (const text of invented) {
    test(`bloquea: "${text}"`, () => {
      const r = postGuard(text, rules, knowledge);
      assert.ok(r.violations.includes('experiencia'), r.details.join(' | ') || 'sin violaciones');
    });
  }

  // Frases legítimas: describen servicios o lo que dice negocio.md, sin afirmar clientes ni casos.
  const legit = [
    'Te ayudamos a definir el mejor camino para tu negocio.',
    'Podemos ayudarte a automatizar la recepción de pedidos.',
    'Atendemos a empresas y emprendimientos con procesos manuales.',
    'Ayudamos a ordenar la operación con software a medida.',
    'No tengo casos confirmados para compartir; eso te lo cuenta el equipo.',
    'Es justo lo que hacemos con negocios como el tuyo.',
  ];
  for (const text of legit) {
    test(`permite: "${text}"`, () => {
      assert.ok(!postGuard(text, rules, knowledge).violations.includes('experiencia'));
    });
  }
});

describe('preGuard: referencias y casos de éxito', () => {
  for (const text of ['¿Tienen casos de éxito?', 'me pasas referencias de clientes?', 'quiero ver su portafolio', '¿con quiénes han trabajado?', '¿tienen experiencia con restaurantes?']) {
    test(`deriva: "${text}"`, () => assert.equal(preGuard(text, rules)?.intent, 'referencias'));
  }
  for (const text of ['me dieron referencias de ustedes y quiero ordenar mi inventario', 'tengo referencias de ustedes por un amigo', 'llevo las referencias de mis productos en Excel']) {
    test(`no deriva por referencias: "${text}"`, () => assert.notEqual(preGuard(text, rules)?.intent, 'referencias'));
  }
});

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
const restaurante = 'tengo un restaurant y los pedidos nos llegan por WhatsApp';

describe('runAgent: "ayudamos a restaurantes"', () => {
  test('reintenta con la instrucción correctiva y envía la versión sin experiencia inventada', async () => {
    const { llm, requests } = scripted([
      { text: 'En DevBull ayudamos a restaurantes a automatizar pedidos. ¿Cuántas personas atienden el WhatsApp?' },
      { text: 'Podemos automatizar la recepción de pedidos con un sistema a medida. ¿Cuántas personas atienden el WhatsApp?' },
    ]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: restaurante }] });
    assert.equal(r.source, 'guard-post-retry');
    assert.doesNotMatch(r.reply ?? '', /ayudamos a restaurantes/i);
    assert.match(requests[1]!.system.at(-1)!.text, /experiencia, clientes o casos/);
  });

  test('si insiste, no se envía: mensaje seguro y derivación', async () => {
    const { llm } = scripted([
      { text: 'Ayudamos a restaurantes como el tuyo. ¿Cuántos son?' },
      { text: 'Hemos trabajado con muchos restaurantes. ¿Cuántos son?' },
    ]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: restaurante }] });
    assert.equal(r.source, 'guard-post-fallback');
    assert.equal(r.reply, rules.post.respuestaSegura);
    assert.match(r.handoff?.motivo ?? '', /experiencia/);
  });
});

describe('experiencia: corrección por oración', () => {
  test('stripExperienceSentences quita solo la oración inventada', async () => {
    const { stripExperienceSentences } = await import('../src/guards/post.js');
    assert.equal(
      stripExperienceSentences('Entiendo. Ayudamos a bodegas como la tuya. Podemos digitalizar tu inventario con un sistema. ¿Cuántos son?', rules),
      'Entiendo. Podemos digitalizar tu inventario con un sistema. ¿Cuántos son?',
    );
  });

  test('si el modelo insiste pero el resto es válido, se envía sin la oración inventada', async () => {
    const insist = 'Ayudamos a bodegas como la tuya. Podemos digitalizar tu inventario con un sistema a medida. ¿Cuántas personas trabajan contigo?';
    const { llm } = scripted([{ text: insist }, { text: insist }]);
    const r = await runAgent({ ...base, llm, history: [{ role: 'user', text: 'tengo una bodega y llevo todo a mano' }] });
    assert.equal(r.source, 'guard-post-fixed');
    assert.equal(r.reply, 'Podemos digitalizar tu inventario con un sistema a medida. ¿Cuántas personas trabajan contigo?');
    assert.equal(r.handoff, null);
  });

  test('describir a quién se dirige DevBull no es experiencia inventada (está en negocio.md)', () => {
    assert.ok(!postGuard('Ayudamos a negocios como el tuyo a dejar el Excel.', rules, knowledge).violations.includes('experiencia'));
    assert.ok(!postGuard('Trabajamos con empresas y emprendimientos.', rules, knowledge).violations.includes('experiencia'));
  });
});
