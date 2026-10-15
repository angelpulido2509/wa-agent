import { detectIntents } from './pre.js';
import { type GuardRules, normalize } from './rules.js';

/**
 * Intenciones que un motivo de handoff puede atribuirle al cliente. Si el motivo afirma una de ellas
 * y el cliente no la expresó, el motivo está inventado (p. ej. "Pide cotización" sin que la pidiera).
 */
const CLAIMS: { intent: string; motivo: RegExp; customer: RegExp }[] = [
  { intent: 'precio', motivo: /cotiza|precio|presupuesto|costo|tarifa|cu[aá]nto cuesta/i, customer: /cotiza|precio|presupuesto|costo|cuesta|cobra|tarifa|cu[aá]nto (me )?(sale|vale|saldr)/i },
  { intent: 'plazo', motivo: /plazo|tiempo de entrega|fecha de entrega|cu[aá]nto (se )?tarda/i, customer: /plazo|tarda|demora|entrega|cu[aá]ndo est/i },
  { intent: 'horario', motivo: /horario|hora de atenci/i, customer: /horario|a qu[eé] hora|atienden/i },
  { intent: 'pagos', motivo: /forma(s)? de pago|m[eé]todo(s)? de pago|c[oó]mo pagar|financiamiento/i, customer: /pag|zelle|cuotas|financ/i },
  { intent: 'reunion', motivo: /reuni[oó]n|llamada|videollamada|demo|agendar|cita/i, customer: /reuni|llam|demo|agend|cita|meet|zoom/i },
  { intent: 'tecnologia', motivo: /tecnolog|stack|framework|lenguaje de program/i, customer: /tecnolog|stack|framework|lenguaje|program/i },
  { intent: 'persona', motivo: /hablar con (una )?persona|asesor|humano/i, customer: /persona|humano|asesor|alguien|agente/i },
  { intent: 'reclamo', motivo: /reclamo|queja|soporte|garant[ií]a|devoluci/i, customer: /reclam|quej|soporte|garant|devol|molest|estaf/i },
  {
    intent: 'referencias',
    motivo: /referencia|caso(s)? de [eé]xito|portafolio|portfolio|contacto de (un|alg[uú]n|sus|otros?) cliente/i,
    customer: /referen|caso|portaf|portfol|experiencia|trabajado|cliente/i,
  },
];

export interface HandoffDecision {
  allow: boolean;
  /** Motivo final (puede ser el original o un resumen literal de lo que dijo el cliente). */
  motivo: string;
  /** Explicación para el log cuando se bloquea o se corrige. */
  note?: string;
}

export interface HandoffContext {
  /** true si el bot todavía no ha respondido nada en esta conversación. */
  firstContact: boolean;
  /** Todo lo que escribió el cliente en la conversación. */
  customerTexts: string[];
  /** El último turno del cliente (para el resumen literal). */
  lastCustomerText: string;
  rules: GuardRules;
}

const MAX_QUOTE = 140;

export function literalSummary(text: string): string {
  const quote = text.replace(/\s+/g, ' ').trim();
  return `El cliente escribió: «${quote.length > MAX_QUOTE ? `${quote.slice(0, MAX_QUOTE)}…` : quote}»`;
}

/** Intenciones que el motivo afirma y que el cliente nunca expresó. */
export function inventedClaims(motivo: string, customerTexts: string[], rules: GuardRules): string[] {
  const joined = customerTexts.join('\n');
  const expressed = new Set(detectIntents(joined, rules));
  const normCustomer = normalize(joined);
  return CLAIMS.filter((c) => c.motivo.test(motivo) && !expressed.has(c.intent) && !c.customer.test(normCustomer)).map((c) => c.intent);
}

/**
 * Palabras de un motivo que NO cuentan como "hechos": verbos y sustantivos genéricos del handoff
 * ("pide", "sistema", "automatizar", "personas", "procesos manuales"…). Todo lo demás (rubro, problema,
 * herramienta, cantidades) tiene que aparecer en lo que escribió el cliente.
 */
const GENERIC_WORDS = new Set(
  (
    'cliente clientes posible pide piden pidio quiere quieren queria necesita necesitan busca buscan desea interesado interesada interes ' +
    'consulta consultar pregunta pregunto preguntando informacion info sobre para como cual cuales donde cuando porque tiene tienen tener ' +
    'hace hacen hacer esta estan este esto esos esas todo todos toda todas mucho muchos mucha poco algo algun alguna otro otra otros ' +
    'tambien ademas segun actualmente ahora hoy solo cada mismo misma sistema sistemas programa programas software solucion soluciones ' +
    'aplicacion aplicaciones plataforma herramienta herramientas gestionar gestion automatizar automatizacion automatizado digitalizar ' +
    'digitalizacion organizar organizacion ordenar mejorar mejora ayuda ayudar apoyo negocio negocios empresa emprendimiento equipo ' +
    'persona personas trabajan trabaja proceso procesos manual manuales manualmente registro registros registrar control controlar ' +
    'manejo manejar maneja operacion area problema problemas desorden desordenado tecnologia tecnologica devbull dato datos tiempo ' +
    'caso servicio servicios desarrollo desarrollar crear implementar mensaje mensajes conversacion transferencia transferir humano ' +
    'motivo menos poco bien mejor forma tipo usar usa usan usando llevar lleva llevan lleve tipo diagnostico reunion contacto contactar ' +
    'escribio dijo indica menciona comenta cuenta tamano aproximadamente unos unas cerca menos minimo minima'
  ).split(' '),
);

function stemMatch(word: string, said: string[]): boolean {
  if (said.includes(word)) return true;
  // Raíz de 4 letras: cubre conjugaciones y plurales ("anoto" ↔ "anotados", "factura" ↔ "facturación").
  if (word.length < 5) return false;
  const stem = word.slice(0, 4);
  return said.some((t) => t.length >= 4 && t.slice(0, 4) === stem);
}

/** Conceptos del motivo (palabras de contenido y números) que el cliente nunca escribió. */
export function unsupportedConcepts(motivo: string, customerTexts: string[]): string[] {
  const said = normalize(customerTexts.join(' ')).split(' ').filter(Boolean);
  const words = normalize(motivo)
    .split(' ')
    .filter((w) => /^\d+$/.test(w) || (w.length >= 4 && !GENERIC_WORDS.has(w)));
  return [...new Set(words.filter((w) => !stemMatch(w, said)))];
}

/** Resumen literal de lo que el cliente escribió en la conversación (últimos mensajes). */
export function customerSummary(customerTexts: string[]): string {
  const parts = customerTexts
    .slice(-5)
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((t) => `«${t.length > 80 ? `${t.slice(0, 80)}…` : t}»`);
  return `El cliente escribió: ${parts.join(' · ')}`;
}

/**
 * Control del handoff que inicia el MODELO (el guard previo ya derivó las intenciones conocidas):
 * - En el primer mensaje, si el guard previo no detectó ninguna intención, el modelo no puede transferir:
 *   debe responder el diagnóstico.
 * - El motivo solo puede contener lo que el cliente dijo; si inventa intenciones, se sustituye por un resumen literal.
 */
export function reviewHandoff(motivo: string, ctx: HandoffContext): HandoffDecision {
  if (ctx.firstContact && !firstContactAllowed(motivo, ctx.customerTexts)) {
    return {
      allow: false,
      motivo,
      note: `handoff en el primer mensaje sin intención detectada (motivo propuesto: «${motivo}»)`,
    };
  }
  const invented = inventedClaims(motivo, ctx.customerTexts, ctx.rules);
  if (invented.length) {
    return {
      allow: true,
      motivo: literalSummary(ctx.lastCustomerText),
      note: `motivo con intenciones no expresadas (${invented.join(', ')}): «${motivo}»`,
    };
  }
  // Cada concepto del motivo debe estar en lo que escribió el cliente (no lo que sugirió el bot).
  const extra = unsupportedConcepts(motivo, ctx.customerTexts);
  if (extra.length) {
    return {
      allow: true,
      motivo: customerSummary(ctx.customerTexts),
      note: `motivo con conceptos que el cliente no escribió (${extra.join(', ')}): «${motivo}»`,
    };
  }
  return { allow: true, motivo };
}

/**
 * Pedidos que siempre van a una persona, aunque sea el primer mensaje: referencias o contacto de un cliente,
 * reclamos y hablar con una persona. Solo cuentan si el motivo lo afirma Y el cliente lo expresó.
 */
const FIRST_CONTACT_OK = new Set(['referencias', 'reclamo', 'persona']);

export function firstContactAllowed(motivo: string, customerTexts: string[]): boolean {
  const said = normalize(customerTexts.join(' '));
  return CLAIMS.some((c) => FIRST_CONTACT_OK.has(c.intent) && c.motivo.test(motivo) && c.customer.test(said));
}

/** Instrucción que recibe el modelo cuando se le bloquea un handoff prematuro. */
export const PREMATURE_HANDOFF_RESULT =
  'NO TRANSFERIDO: es el primer mensaje de la persona y no pidió precio, plazos, horario, pagos, reunión, tecnología, ' +
  'un reclamo ni hablar con una persona. No transfieras todavía. Responde tú: reconoce con sus palabras lo que contó, ' +
  'nombra un servicio de la información del negocio que aplique y haz UNA sola pregunta de diagnóstico.';
