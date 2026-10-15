import { askedForService, detectServicios, priceMotivo, priceReply, type ServicioDetectado } from './precios.js';
import { containsPhrase, type GuardRules, normalize, type PreIntent } from './rules.js';

export interface PreGuardHit {
  intent: string;
  /** Frase o combinación que activó la regla (para el log). */
  matched: string;
  reply: string;
  /** Motivo del handoff; null = se responde sin pasar a una persona (horario, pagos, reunión gratis, pregunta de servicio). */
  motivo: string | null;
}

/** Lo que el guard previo necesita saber de la conversación (para precios). */
export interface PreGuardContext {
  /** Último mensaje del bot (o de una persona del equipo), si lo hay. */
  lastBotText?: string;
  /** Mensajes anteriores del cliente (sin el actual), del más viejo al más reciente. */
  previousCustomerTexts?: string[];
}

export function matchIntent(text: string, intent: PreIntent): string | null {
  if (intent.exclude?.some((p) => containsPhrase(text, p))) return null;
  const keyword = intent.keywords.find((k) => containsPhrase(text, k));
  if (keyword) return keyword;
  for (const combo of intent.combos ?? []) {
    const hits = combo.map((group) => group.find((term) => containsPhrase(text, term)));
    if (hits.every(Boolean)) return hits.join(' + ');
  }
  return null;
}

const MAX_QUOTE = 140;

function shortQuote(text: string): string {
  const quote = text.replace(/\s+/g, ' ').trim();
  return quote.length > MAX_QUOTE ? `${quote.slice(0, MAX_QUOTE)}…` : quote;
}

/**
 * Control ANTES del modelo, con respuestas fijas de reglas.json:
 * - "derivar": lo que solo responde una persona (plazos, agendar, stack, reclamos…) → texto fijo + handoff.
 * - "responder": datos confirmados (horario, pagos, reunión gratis) → texto fijo + UNA pregunta, sin handoff.
 * - "precios": rango referencial del servicio que nombró el cliente + handoff; sin servicio, UNA pregunta.
 */
export function preGuard(customerText: string, rules: GuardRules, ctx: PreGuardContext = {}): PreGuardHit | null {
  const text = normalize(customerText);
  if (!text) return null;
  const quote = shortQuote(customerText);
  for (const intent of rules.pre.intents) {
    const matched = matchIntent(text, intent);
    if (!matched) continue;
    if (intent.accion === 'precios' && rules.precios) {
      const precios = rules.precios;
      let detectados = detectServicios(customerText, precios);
      const quotes = [quote];
      if (!detectados.length && intent.sinServicio !== 'seguir') {
        // "¿Y cuánto me sale?" después de haber nombrado el servicio en un mensaje anterior.
        for (const prev of [...(ctx.previousCustomerTexts ?? [])].reverse()) {
          detectados = detectServicios(prev, precios);
          if (detectados.length) {
            quotes.unshift(shortQuote(prev));
            break;
          }
        }
      }
      if (!detectados.length) {
        if (intent.sinServicio === 'seguir') continue;
        return { intent: intent.id, matched: `${matched} (sin servicio)`, reply: precios.preguntaSinServicio, motivo: null };
      }
      const hit = priceHit(intent.id, matched, detectados, intent.motivo, quotes, rules);
      // ¿El mismo mensaje trae otra consulta? Se responde el precio y la otra queda para la persona.
      const otras = rules.pre.intents
        .filter((i) => i.accion !== 'precios' && i.id !== intent.id && matchIntent(text, i))
        .map((i) => i.motivo.toLowerCase());
      const otraSinIntencion = !otras.length && (customerText.match(/\?/g) ?? []).length >= 2;
      if (otras.length || otraSinIntencion) {
        if (precios.otraPregunta) hit.reply = `${hit.reply} ${precios.otraPregunta}`;
        hit.motivo = `${hit.motivo} · También pregunta: ${otras.length ? otras.join('; ') : 'otra consulta (ver mensaje)'}`;
        hit.matched = `${hit.matched} + ${otras.length ? 'otra intención' : 'otra pregunta'}`;
      }
      return hit;
    }
    const derivar = intent.accion !== 'responder';
    return { intent: intent.id, matched, reply: intent.respuesta, motivo: derivar ? `${intent.motivo}: «${quote}»` : null };
  }
  // Respuesta a "¿Para qué producto o servicio necesitas el precio?".
  if (rules.precios && askedForService(ctx.lastBotText, rules.precios)) {
    const precios = rules.precios;
    const asked = [...(ctx.previousCustomerTexts ?? [])].reverse().find((t) => t.trim());
    const quotes = asked ? [shortQuote(asked), quote] : [quote];
    const detectados = detectServicios(customerText, precios);
    if (detectados.length) return priceHit('precio', 'respuesta a la pregunta de servicio', detectados, 'Pide precio', quotes, rules);
    return {
      intent: 'precio',
      matched: 'respuesta a la pregunta de servicio (sin servicio)',
      reply: precios.sinServicioTrasPregunta,
      motivo: `Pide precio: ${quotes.map((q) => `«${q}»`).join(' · ')}`,
    };
  }
  return null;
}

function priceHit(
  intent: string,
  matched: string,
  detectados: ServicioDetectado[],
  prefix: string,
  quotes: string[],
  rules: GuardRules,
): PreGuardHit {
  const precios = rules.precios!;
  return {
    intent,
    matched: `${matched} → ${detectados.map((d) => d.servicio.id).join(', ')}`,
    reply: priceReply(detectados, precios),
    motivo: priceMotivo(prefix, detectados, precios, quotes),
  };
}

/** Todas las intenciones presentes en el texto del cliente (para validar el motivo de un handoff). */
export function detectIntents(customerText: string, rules: GuardRules): string[] {
  const text = normalize(customerText);
  return text ? rules.pre.intents.filter((i) => matchIntent(text, i)).map((i) => i.id) : [];
}

const MEDIA_LINE = /^\[(audio|imagen|video|documento|sticker|ubicación|contacto)\]$/i;

/** ¿El turno del cliente es solo multimedia sin texto? (un mensaje por línea, como lo guarda el gateway) */
export function isMediaOnly(customerText: string): boolean {
  const lines = customerText.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => MEDIA_LINE.test(l));
}
