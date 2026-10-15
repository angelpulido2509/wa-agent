import 'dotenv/config';
import { runAgent } from './agent.js';
import { ConfigError, loadConfig } from './config.js';
import { createDb } from './db.js';
import { createLlm, describeLlm, LlmError } from './llm/index.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';
import { WhatsAppGateway } from './whatsapp.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const db = createDb(config.dbPath);
  const isStub = config.provider === 'stub';
  const llm = createLlm(config, {
    log: (message, data) => logger.info({ module: 'llm', ...data }, message),
  });
  if (isStub) {
    logger.warn('[STUB] Proveedor de PRUEBA activo: respuestas fijas, solo para TEST_MODE=true. No usar con clientes reales.');
  }

  const gateway = new WhatsAppGateway({
    config,
    db,
    logger,
    respond: async (jid) => {
      try {
        const result = await runAgent({
          llm,
          businessName: config.businessName,
          knowledgePath: config.knowledgePath,
          rulesPath: config.rulesPath,
          history: db.recentMessages(jid, 30),
        });
        for (const ev of result.guardEvents) {
          logger.warn({ jid, stage: ev.stage, action: ev.action, detail: ev.detail }, 'Control automático');
        }
        logger.info(
          { jid, source: result.source, handoff: result.handoff, usage: result.usage },
          isStub ? '[STUB] Respuesta del agente' : 'Respuesta del agente',
        );
        return result;
      } catch (err) {
        // Sin LLM no hay respuesta: se registra y el chat queda sin contestar (no se inventa nada).
        if (err instanceof LlmError) logger.error({ jid, provider: err.provider, status: err.status }, err.message);
        throw err;
      }
    },
  });

  const app = await buildServer({
    db,
    gateway,
    panelToken: config.panelToken,
    handoffPauseHours: config.handoffPauseHours,
    logger: logger.child({ module: 'http' }),
  });
  await app.listen({ host: '127.0.0.1', port: config.port });
  logger.info(
    { testMode: config.testMode, testNumbers: [...config.testNumbers], llm: describeLlm(config) },
    `Panel: http://127.0.0.1:${config.port}/  (pega tu PANEL_TOKEN al abrirlo)`,
  );

  await gateway.start();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'Cerrando…');
    await gateway.stop().catch(() => undefined);
    await app.close().catch(() => undefined);
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`Configuración inválida: ${err.message}`);
  } else {
    console.error('Error fatal:', err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
