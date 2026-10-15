import 'dotenv/config';
import readline from 'node:readline/promises';
import Anthropic from '@anthropic-ai/sdk';
import { type HistoryItem, runAgent } from './agent.js';
import { ConfigError, loadLlmConfig } from './config.js';
import { createLlm, describeLlm, LlmError } from './llm/index.js';

let config;
try {
  config = loadLlmConfig();
} catch (err) {
  console.error(err instanceof ConfigError ? `Configuración inválida: ${err.message}` : err);
  process.exit(1);
}
const llm = createLlm(config);
const history: HistoryItem[] = [];
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log(`Chat de prueba con el agente de ${config.businessName} (${describeLlm(config)}).`);
console.log('Escribe como si fueras un cliente. /reset reinicia la conversación, /salir termina.\n');

for (;;) {
  const line = (await rl.question('Tú: ')).trim();
  if (!line) continue;
  if (line === '/salir') break;
  if (line === '/reset') {
    history.length = 0;
    console.log('— conversación reiniciada —\n');
    continue;
  }

  history.push({ role: 'user', text: line });
  try {
    const { reply, handoff, usage, guardEvents } = await runAgent({
      llm,
      businessName: config.businessName,
      knowledgePath: config.knowledgePath,
      rulesPath: config.rulesPath,
      history,
    });
    for (const ev of guardEvents) console.log(`  ↳ control ${ev.stage}/${ev.action}: ${ev.detail}`);
    if (reply) {
      history.push({ role: 'bot', text: reply });
      console.log(`\nBot: ${reply}`);
    } else {
      console.log('\nBot: (sin respuesta)');
    }
    if (handoff) console.log(`  ↳ TRANSFERENCIA A HUMANO — motivo: ${handoff.motivo}`);
    console.log(
      `  ↳ ${(usage.latencyMs / 1000).toFixed(1)} s · ${usage.calls} llamada(s) · tokens: in=${usage.inputTokens} ` +
        `out=${usage.outputTokens} cache_read=${usage.cacheReadTokens} cache_write=${usage.cacheWriteTokens}\n`,
    );
  } catch (err) {
    if (err instanceof LlmError) console.error(err.message);
    else if (err instanceof Anthropic.AuthenticationError) console.error('API key inválida (401).');
    else if (err instanceof Anthropic.APIError) console.error(`Error de la API (${err.status}): ${err.message}`);
    else console.error(err);
    history.pop();
  }
}

rl.close();
