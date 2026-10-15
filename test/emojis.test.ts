import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { buildSystem, runAgent } from '../src/agent.js';
import { replaceRoleplay } from '../src/guards/post.js';
import { parseRules, RulesError } from '../src/guards/rules.js';
import { parseBusinessRules } from '../src/guards/negocio.js';
import type { LlmProvider, LlmResponse } from '../src/llm/types.js';
import { ROLEPLAY } from '../src/scenario-checks.js';

const rules = parseBusinessRules(fs.readFileSync('knowledge/reglas.json', 'utf8'), fs.readFileSync('knowledge/negocio.md', 'utf8'));
const knowledge = fs.readFileSync('knowledge/negocio.md', 'utf8');

describe('acotaciones de rol → emojis', () => {
  test('casos reales de la prueba en vivo', () => {
    assert.equal(
      replaceRoleplay('¡Hola! *sonríe* Solo puedo ayudarte con temas de DevBull, ¿qué necesitas para tu negocio?', rules),
      '¡Hola! 😊 Solo puedo ayudarte con temas de DevBull, ¿qué necesitas para tu negocio?',
    );
    assert.equal(
      replaceRoleplay('*Sonríe* ¡Claro! *emoji de sonrisa*. ¿Tienes algo que automatizar?', rules),
      '😊 ¡Claro! ¿Tienes algo que automatizar?',
    );
  });

  test('otras acotaciones y emojis descritos con palabras', () => {
    assert.equal(replaceRoleplay('*risas* Buena pregunta.', rules), '😄 Buena pregunta.');
    assert.equal(replaceRoleplay('¡Listo! *guiña un ojo*', rules), '¡Listo! 😉');
    assert.equal(replaceRoleplay('Vamos con todo *emoji de cohete*', rules), 'Vamos con todo 🚀');
    assert.equal(replaceRoleplay('Perfecto *emoji de algo raro*', rules), 'Perfecto 🙂');
  });

  test('la negrita normal de WhatsApp no se toca', () => {
    const text = 'Con un *sistema de inventario* y *automatización* podrías ahorrar tiempo. ¿Cuántos son?';
    assert.equal(replaceRoleplay(text, rules), text);
    assert.equal(replaceRoleplay('Somos *DevBull* 🚀', rules), 'Somos *DevBull* 🚀');
  });

  test('el prompt pide emojis reales y prohíbe gestos entre asteriscos', () => {
    const stable = buildSystem('DevBull', knowledge, new Date(), 'detailed')[0]!.text;
    assert.match(stable, /usa emojis reales con moderación/);
    assert.match(stable, /Nunca escribas acotaciones escénicas, gestos o acciones entre asteriscos \(como \*sonríe\* o \*ríe\*\)/);
  });

  test('runAgent convierte la acotación antes de enviar', async () => {
    const llm: LlmProvider = {
      name: 'openai-compatible',
      model: 'fake',
      async chat(): Promise<LlmResponse> {
        return {
          text: '¡Hola! *sonríe* En DevBull digitalizamos procesos manuales. ¿Qué tipo de negocio tienes?',
          toolCalls: [],
          stopReason: 'end',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 1 },
        };
      },
    };
    const r = await runAgent({ llm, businessName: 'DevBull', knowledgePath: 'knowledge/negocio.md', rules, history: [{ role: 'user', text: 'hola' }] });
    assert.equal(r.reply, '¡Hola! 😊 En DevBull digitalizamos procesos manuales. ¿Qué tipo de negocio tienes?');
  });

  test('el validador de escenarios detecta acotaciones sin convertir', () => {
    assert.ok(ROLEPLAY.test('Claro *sonríe*'));
    assert.ok(ROLEPLAY.test('*emoji de sonrisa*'));
    assert.ok(!ROLEPLAY.test('Un *sistema de inventario* te ayuda'));
  });

  test('reglas.json mal editado en acotaciones falla claro', () => {
    const bad = JSON.parse(fs.readFileSync('knowledge/reglas.json', 'utf8'));
    bad.post.acotaciones = { sonrie: 1 };
    assert.throws(() => parseRules(JSON.stringify(bad)), RulesError);
  });
});
