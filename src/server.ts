import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import type { GatewayStatus } from './whatsapp.js';

/** Lo que el servidor necesita del gateway; permite testearlo sin WhatsApp. */
export interface GatewayPort {
  readonly status: GatewayStatus;
  logout(): Promise<void>;
  on(event: 'status', listener: (s: GatewayStatus) => void): unknown;
  on(event: 'chats', listener: () => void): unknown;
  off(event: 'status', listener: (s: GatewayStatus) => void): unknown;
  off(event: 'chats', listener: () => void): unknown;
}

export interface ServerOptions {
  db: Db;
  gateway: GatewayPort;
  panelToken: string;
  handoffPauseHours: number;
  logger?: FastifyBaseLogger;
}

type ApiBody<T> = { success: true; data: T; error: null } | { success: false; data: null; error: string };

const ok = <T>(data: T): ApiBody<T> => ({ success: true, data, error: null });
const fail = (error: string): ApiBody<never> => ({ success: false, data: null, error });

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const { db, gateway } = opts;
  const app = Fastify({ loggerInstance: opts.logger, disableRequestLogging: true });

  await app.register(fastifyStatic, { root: publicDir, index: 'index.html' });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return;
    const header = req.headers['x-panel-token'];
    const query = (req.query as Record<string, string | undefined>).token;
    const given = typeof header === 'string' ? header : query;
    if (!tokenMatches(given, opts.panelToken)) {
      return reply.code(401).send(fail('No autorizado'));
    }
  });

  app.get('/api/status', async () => ok(gateway.status));

  app.get('/api/chats', async () => ok(db.listChats()));

  app.get<{ Params: { jid: string }; Querystring: { limit?: string } }>(
    '/api/chats/:jid/messages',
    async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      return ok({ chat: db.getChat(req.params.jid) ?? null, messages: db.recentMessages(req.params.jid, limit) });
    },
  );

  app.post<{ Params: { jid: string }; Body: { hours?: number; reason?: string } | undefined }>(
    '/api/chats/:jid/pause',
    async (req) => {
      const hours = Number(req.body?.hours) > 0 ? Number(req.body?.hours) : opts.handoffPauseHours;
      const reason = req.body?.reason?.toString().slice(0, 200) || 'Pausado desde el panel';
      db.pauseChat(req.params.jid, Date.now() + hours * 3_600_000, reason);
      return ok(db.getChat(req.params.jid) ?? null);
    },
  );

  app.post<{ Params: { jid: string } }>('/api/chats/:jid/resume', async (req) => {
    db.resumeChat(req.params.jid);
    return ok(db.getChat(req.params.jid) ?? null);
  });

  app.post('/api/logout', async (_req, reply) => {
    try {
      await gateway.logout();
      return ok({ loggedOut: true });
    } catch (err) {
      app.log.error({ err }, 'Error al desvincular');
      return reply.code(500).send(fail('No se pudo desvincular el número'));
    }
  });

  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    send('status', gateway.status);
    send('chats', db.listChats());

    const onStatus = (s: GatewayStatus) => send('status', s);
    const onChats = () => send('chats', db.listChats());
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    gateway.on('status', onStatus);
    gateway.on('chats', onChats);

    req.raw.on('close', () => {
      clearInterval(ping);
      gateway.off('status', onStatus);
      gateway.off('chats', onChats);
    });
  });

  return app;
}
