import pino, { type Logger } from 'pino';

/** Logger raíz. Redacta cualquier campo que pueda contener secretos. */
export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: ['apiKey', '*.apiKey', 'anthropicApiKey', '*.anthropicApiKey', 'panelToken', '*.panelToken', 'headers["x-api-key"]', 'headers["x-panel-token"]'],
      censor: '[oculto]',
    },
  });
}
