import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateMessageIDV2,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  isLidUser,
  isPnUser,
  jidDecode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
  type ConnectionState,
  type MessageUpsertType,
  type WAMessage,
  type WAMessageContent,
  type WAMessageKey,
  type WASocket,
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import QRCode from 'qrcode';
import type { AgentResult } from './agent.js';
import { type Config, onlyDigits } from './config.js';
import type { Db } from './db.js';
import { KeyedDebouncer } from './debounce.js';

export type ConnectionStatus = 'starting' | 'qr' | 'connecting' | 'open' | 'logged_out' | 'closed';

export interface GatewayStatus {
  status: ConnectionStatus;
  /** QR como data URL (solo en estado 'qr') */
  qr: string | null;
  /** Número vinculado (solo dígitos) */
  me: string | null;
  updatedAt: number;
}

export interface GatewayEvents {
  status: [GatewayStatus];
  chats: [];
}

export type Responder = (jid: string) => Promise<Pick<AgentResult, 'reply' | 'handoff'>>;

export interface GatewayOptions {
  config: Config;
  db: Db;
  logger: Logger;
  respond: Responder;
}

const RECENT_WINDOW_MS = 120_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_TRACKED_SENT_IDS = 2_000;

const MEDIA_LABELS: Partial<Record<keyof WAMessageContent, string>> = {
  audioMessage: '[audio]',
  imageMessage: '[imagen]',
  videoMessage: '[video]',
  ptvMessage: '[video]',
  documentMessage: '[documento]',
  documentWithCaptionMessage: '[documento]',
  stickerMessage: '[sticker]',
  locationMessage: '[ubicación]',
  liveLocationMessage: '[ubicación]',
  contactMessage: '[contacto]',
  contactsArrayMessage: '[contacto]',
};

/** Extrae el texto de un mensaje o una etiqueta para multimedia. Devuelve null si no es un mensaje de chat. */
export function messageToText(raw: WAMessageContent | null | undefined): string | null {
  const content = normalizeMessageContent(raw);
  if (!content) return null;
  const type = getContentType(content);
  if (!type) return null;

  if (type === 'conversation') return content.conversation?.trim() || null;
  if (type === 'extendedTextMessage') return content.extendedTextMessage?.text?.trim() || null;

  const label = MEDIA_LABELS[type];
  if (!label) return null;
  const caption =
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    content.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    '';
  return caption.trim() ? `${label} ${caption.trim()}` : label;
}

function timestampMs(ts: WAMessage['messageTimestamp']): number {
  if (typeof ts === 'number') return ts * 1000;
  if (ts && typeof ts === 'object' && 'toNumber' in ts) return ts.toNumber() * 1000;
  return Date.now();
}

function disconnectCode(update: Partial<ConnectionState>): number | undefined {
  const error = update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
  return error?.output?.statusCode;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class WhatsAppGateway extends EventEmitter<GatewayEvents> {
  private sock: WASocket | null = null;
  private state: GatewayStatus = { status: 'starting', qr: null, me: null, updatedAt: Date.now() };
  private attempts = 0;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly botSentIds = new Set<string>();
  private readonly unreadKeys = new Map<string, WAMessageKey[]>();
  /** Momento (ms) en que se guardó el último mensaje del cliente en cada chat. */
  private readonly lastIncomingAt = new Map<string, number>();
  private readonly log: Logger;
  /** Junta ráfagas por chat y garantiza un solo turno del agente a la vez por chat. */
  private readonly debouncer: KeyedDebouncer;

  constructor(private readonly opts: GatewayOptions) {
    super();
    this.log = opts.logger.child({ module: 'whatsapp' });
    this.debouncer = new KeyedDebouncer(
      opts.config.debounceMs,
      (jid) => this.replyTo(jid),
      (err, jid) => this.log.error({ err, jid }, 'Error respondiendo al chat'),
    );
  }

  get status(): GatewayStatus {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    this.setStatus({ status: 'starting', qr: null });

    const { state, saveCreds } = await useMultiFileAuthState(this.opts.config.authDir);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    this.log.info({ version: version.join('.'), isLatest }, 'Versión de WhatsApp Web');

    const baileysLogger = this.opts.logger.child({ module: 'baileys' }, { level: 'error' });
    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
      logger: baileysLogger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
      if (this.sock !== sock) return;
      void this.onConnectionUpdate(update);
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (this.sock !== sock) return;
      void this.onMessages(messages, type).catch((err: unknown) =>
        this.log.error({ err }, 'Error procesando mensajes entrantes'),
      );
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.debouncer.clear();
    const sock = this.sock;
    this.sock = null;
    await sock?.end(undefined);
    this.setStatus({ status: 'closed', qr: null });
  }

  /** Desvincula el número. El cierre con loggedOut borra ./auth y genera un QR nuevo. */
  async logout(): Promise<void> {
    if (this.sock && this.state.status === 'open') {
      await this.sock.logout();
      return;
    }
    await this.resetAuthAndRestart();
  }

  // ---------------------------------------------------------------- conexión

  private async onConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    const { connection, qr } = update;

    if (qr) {
      // Recibir un QR prueba que la conexión con WhatsApp funcionó: el backoff vuelve a empezar.
      this.attempts = 0;
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      this.setStatus({ status: 'qr', qr: dataUrl });
      this.log.info('QR nuevo disponible: escanéalo desde el panel o la terminal');
      QRCode.toString(qr, { type: 'terminal', small: true })
        .then((ascii) => process.stdout.write(`${ascii}\n`))
        .catch(() => undefined);
    }

    if (connection === 'connecting' && this.state.status !== 'qr') {
      this.setStatus({ status: 'connecting' });
    }

    if (connection === 'open') {
      this.attempts = 0;
      const me = this.sock?.user?.id ? jidDecode(this.sock.user.id)?.user ?? null : null;
      this.setStatus({ status: 'open', qr: null, me });
      this.log.info({ me }, 'WhatsApp conectado');
    }

    if (connection === 'close') {
      const code = disconnectCode(update);
      this.sock = null;
      if (this.stopped) return;

      if (code === DisconnectReason.loggedOut) {
        this.log.warn('Sesión cerrada desde el teléfono (loggedOut): se borra ./auth y se genera un QR nuevo');
        this.setStatus({ status: 'logged_out', qr: null, me: null });
        await this.resetAuthAndRestart();
        return;
      }

      if (code === DisconnectReason.connectionReplaced) {
        this.log.error('Otra sesión de este bot abrió la conexión (440). No se reconecta para no pelear con ella.');
        this.setStatus({ status: 'closed', qr: null });
        return;
      }

      if (code === DisconnectReason.restartRequired) {
        this.log.info('WhatsApp pidió reinicio (515): reconectando');
        this.scheduleReconnect(300);
        return;
      }

      // El QR venció sin escanearse: no es una falla de red, se genera otro enseguida (sin backoff).
      if (code === DisconnectReason.timedOut && this.state.status === 'qr') {
        this.log.info('QR vencido sin escanear: generando uno nuevo');
        this.setStatus({ status: 'connecting', qr: null });
        this.scheduleReconnect(500);
        return;
      }

      const delay = Math.min(1000 * 2 ** this.attempts, MAX_BACKOFF_MS);
      this.attempts++;
      this.log.warn({ code, delay }, 'Conexión cerrada: reintentando');
      this.setStatus({ status: 'closed', qr: null });
      this.scheduleReconnect(delay);
    }
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch((err: unknown) => {
        this.log.error({ err }, 'No se pudo iniciar el socket');
        this.scheduleReconnect(Math.min(1000 * 2 ** this.attempts++, MAX_BACKOFF_MS));
      });
    }, delayMs);
  }

  private async resetAuthAndRestart(): Promise<void> {
    const sock = this.sock;
    this.sock = null;
    await sock?.end(undefined);
    await fs.rm(this.opts.config.authDir, { recursive: true, force: true });
    this.attempts = 0;
    this.scheduleReconnect(1000);
  }

  private setStatus(patch: Partial<Omit<GatewayStatus, 'updatedAt'>>): void {
    this.state = { ...this.state, ...patch, updatedAt: Date.now() };
    this.emit('status', this.state);
  }

  // ---------------------------------------------------------------- mensajes

  private isIgnoredJid(jid: string): boolean {
    return Boolean(isJidGroup(jid) || isJidStatusBroadcast(jid) || isJidNewsletter(jid) || isJidBroadcast(jid));
  }

  private isSelfChat(jid: string): boolean {
    const user = this.sock?.user;
    if (!user) return false;
    const normalized = jidNormalizedUser(jid);
    return normalized === jidNormalizedUser(user.id) || (!!user.lid && normalized === jidNormalizedUser(user.lid));
  }

  /** Teléfono (solo dígitos) del chat. Baileys v7 puede entregar JIDs @lid. */
  private async resolvePhone(key: WAMessageKey): Promise<string | null> {
    const fromJid = (jid: string | null | undefined) => {
      const user = jidDecode(jid ?? undefined)?.user;
      return user ? onlyDigits(user) : null;
    };
    if (key.remoteJidAlt && isPnUser(key.remoteJidAlt)) return fromJid(key.remoteJidAlt);
    if (key.remoteJid && isPnUser(key.remoteJid)) return fromJid(key.remoteJid);
    if (key.remoteJid && isLidUser(key.remoteJid) && this.sock) {
      try {
        return fromJid(await this.sock.signalRepository.lidMapping.getPNForLID(key.remoteJid));
      } catch (err) {
        this.log.debug({ err, jid: key.remoteJid }, 'No se pudo resolver el teléfono del LID');
      }
    }
    return null;
  }

  private isAllowed(phone: string | null): boolean {
    const { testMode, testNumbers } = this.opts.config;
    return !testMode || (phone !== null && testNumbers.has(phone));
  }

  private async onMessages(messages: WAMessage[], type: MessageUpsertType): Promise<void> {
    const { db, config } = this.opts;
    let changed = false;

    for (const msg of messages) {
      const { key } = msg;
      const jid = key.remoteJid;
      const waId = key.id;
      if (!jid || !waId || this.isIgnoredJid(jid) || this.isSelfChat(jid)) continue;

      const text = messageToText(msg.message);
      if (!text) continue;

      if (key.fromMe && this.botSentIds.has(waId)) continue; // ya se guardó al enviarlo

      const phone = await this.resolvePhone(key);
      if (!this.isAllowed(phone)) {
        if (!key.fromMe) this.log.info({ jid, phone }, 'Modo prueba: mensaje ignorado (número fuera de TEST_NUMBERS)');
        continue;
      }

      const ts = timestampMs(msg.messageTimestamp);
      const isRecent = Date.now() - ts < RECENT_WINDOW_MS;
      if (phone) db.setChatPhone(jid, phone);

      if (key.fromMe) {
        // Mensaje escrito por el dueño desde su teléfono: el bot cede el chat.
        if (!db.saveMessage({ jid, waId, role: 'owner', text, ts })) continue;
        changed = true;
        if (isRecent) {
          db.pauseChat(jid, Date.now() + config.handoffPauseHours * 3_600_000, 'El dueño respondió manualmente');
          this.debouncer.cancel(jid);
          this.log.info({ jid }, `Dueño respondió: bot pausado ${config.handoffPauseHours} h en este chat`);
        }
        continue;
      }

      if (msg.pushName) db.setChatName(jid, msg.pushName);
      if (!db.saveMessage({ jid, waId, role: 'user', text, ts })) continue;
      changed = true;
      this.lastIncomingAt.set(jid, Date.now());

      if (type === 'notify' && isRecent) {
        const keys = this.unreadKeys.get(jid) ?? [];
        keys.push(key);
        this.unreadKeys.set(jid, keys);
        this.debouncer.schedule(jid);
      }
    }

    if (changed) this.emit('chats');
  }

  private async replyTo(jid: string): Promise<void> {
    const { db, config } = this.opts;
    const sock = this.sock;
    if (!sock || this.state.status !== 'open') return;
    if (db.isPaused(jid)) {
      this.unreadKeys.delete(jid);
      return;
    }
    if (db.repliesLastHour(jid) >= config.maxRepliesPerHour) {
      this.log.warn({ jid }, `Límite de ${config.maxRepliesPerHour} respuestas/hora alcanzado: no se responde`);
      return;
    }

    const keys = this.unreadKeys.get(jid) ?? [];
    this.unreadKeys.delete(jid);
    if (keys.length) await sock.readMessages(keys).catch(() => undefined);
    await sock.sendPresenceUpdate('composing', jid).catch(() => undefined);

    const startedAt = Date.now();
    /** Si el cliente escribe mientras "escribimos", esta respuesta queda vieja: no se envía. */
    const isStale = () => (this.lastIncomingAt.get(jid) ?? 0) >= startedAt;
    try {
      const { reply, handoff } = await this.opts.respond(jid);
      if (reply) {
        const typingMs = Math.min(1200 + 30 * reply.length, 7000);
        await sleep(Math.max(0, typingMs - (Date.now() - startedAt)));
        // El dueño pudo tomar el chat mientras "escribíamos".
        if (db.isPaused(jid) || this.sock !== sock) return;
        if (isStale()) {
          // El debouncer ya tiene programada otra vuelta: responderá una sola vez con todos los mensajes.
          this.log.info({ jid }, 'Mensaje nuevo durante la escritura: se descarta la respuesta y se regenera con todo');
          return;
        }
        await this.sendText(jid, reply, true);
      }
      if (handoff && !isStale()) await this.handoff(jid, handoff.motivo);
    } finally {
      await sock.sendPresenceUpdate('paused', jid).catch(() => undefined);
    }
  }

  private async handoff(jid: string, motivo: string): Promise<void> {
    const { db, config } = this.opts;
    db.pauseChat(jid, Date.now() + config.handoffPauseHours * 3_600_000, motivo);
    this.emit('chats');
    this.log.info({ jid, motivo }, 'Chat transferido a humano');

    const selfJid = this.sock?.user?.id ? jidNormalizedUser(this.sock.user.id) : null;
    if (!config.notifyOwner || !selfJid) return;
    const chat = db.getChat(jid);
    const cliente = chat?.phone ? `+${chat.phone}` : jid;
    const nombre = chat?.name ? ` (${chat.name})` : '';
    const aviso =
      `🔔 *Atención humana requerida*\n` +
      `Cliente: ${cliente}${nombre}\n` +
      `Motivo: ${motivo}\n` +
      `El bot quedó pausado ${config.handoffPauseHours} h en ese chat.`;
    await this.sendText(selfJid, aviso, false).catch((err: unknown) =>
      this.log.error({ err }, 'No se pudo enviar el aviso al dueño'),
    );
  }

  /** Envía texto registrando el id como propio del bot (para distinguirlo de lo que escribe el dueño). */
  private async sendText(jid: string, text: string, persist: boolean): Promise<void> {
    const sock = this.sock;
    if (!sock) throw new Error('Socket no conectado');
    const messageId = generateMessageIDV2(sock.user?.id);
    this.trackSentId(messageId);
    const sent = await sock.sendMessage(jid, { text }, { messageId });
    const waId = sent?.key.id ?? messageId;
    this.trackSentId(waId);
    if (persist) {
      this.opts.db.saveMessage({ jid, waId, role: 'bot', text, ts: Date.now() });
      this.emit('chats');
    }
  }

  private trackSentId(id: string): void {
    this.botSentIds.add(id);
    if (this.botSentIds.size > MAX_TRACKED_SENT_IDS) {
      const oldest = this.botSentIds.values().next().value;
      if (oldest !== undefined) this.botSentIds.delete(oldest);
    }
  }
}
