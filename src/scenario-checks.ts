/**
 * Validaciones de los escenarios de regresión. Son INDEPENDIENTES de los guards del bot
 * (no usan reglas.json): así un guard mal configurado no puede aprobarse a sí mismo.
 */

/** Servicios que aparecen en negocio.md: la respuesta al describir un problema debe nombrar alguno. */
export const SERVICE = /software|sistema|ERP|\bapps?\b|aplicaci[oó]n|plataforma|automatiz|digitaliz|inteligencia artificial|\bIA\b|asistente|integra/i;

export const PRICE = /(\$|usd|us\$|bs\.?\s?\d|€|\d+\s?(d[oó]lares|bol[ií]vares)|desde\s+\d)/i;
export const DURATION = /\d+\s*(a\s*\d+\s*)?(d[ií]as?|semanas?|meses|mes|horas?)\b/i;
export const CLOCK = /\b\d{1,2}(:\d{2})?\s*(am|pm|a\.\s?m\.|p\.\s?m\.|hrs?)\b|\b\d{1,2}:\d{2}\b/i;
export const STACK = /\b(react|angular|vue|node|python|java|php|laravel|django|flutter|\.net|typescript|javascript)\b/i;

/** Voseo: las formas que coinciden con el tuteo salvo por la tilde (sabés/sabes, usás/usas) exigen la tilde. */
export const VOSEO =
  /(?<![\p{L}])(ten[eé]s|pod[eé]s|quer[eé]s|sabés|hacés|vendés|recib[ií]s|anotás|manejás|necesitás|contás|usás|llevás|trabajás|mirá|pertenecés|vos|sos|decime|contame|fijate|hablame|escribime|mandame|pasame|llamame|avisame|contá|decí|mandá|escribí|avisá|enviá|enviálos|andá|tené|poné|vení|hacé|pedí|elegí|probá|usá|llamá|pasá|esperá|dejá|hablá|preguntá)(?![\p{L}])/iu;

/**
 * Experiencia, clientes o casos inventados. "Ayudamos a negocios como el tuyo" / "a empresas y emprendimientos"
 * NO cuenta: describe el público objetivo que define negocio.md (mismo criterio que el guard).
 */
export const INVENTED_EXPERIENCE =
  /\b(ayudamos|trabajamos con|atendemos|apoyamos)\s+a?\s*(los |las |muchos |muchas )?(restaurant|cl[ií]nica|consultorio|tienda|distribuidora|ferreter|panader|bodega|farmacia|taller|comercio|pyme)|hemos (ayudado|trabajado|implementado|desarrollado para)|nuestros clientes|otros clientes|clientes como (t[uú]|usted)|casos? de [eé]xito|tenemos experiencia/i;

/** Oferta por rubro en presente, dentro de una misma oración ("creamos … para panaderías"). */
export const OFFER_BY_SECTOR =
  /\b(desarrollamos|hacemos|creamos|ofrecemos|tenemos|diseñamos|implementamos|construimos|brindamos|vendemos|sistemas?|apps?|aplicaci[oó]n(es)?|soluci[oó]n(es)?|plataformas?|erp|software|programas?)\b[^.!?\n]{0,80}\bpara (las |los )?(bodegas|restaurant(e)?s|cl[ií]nicas|consultorios|panader[ií]as|tiendas|ferreter[ií]as|distribuidoras|farmacias|talleres|comercios|pizzer[ií]as|hoteles|gimnasios|colegios)\b/i;

/** Funciones concretas que negocio.md no incluye (el bot no debe prometerlas). */
export const PROMISED_FEATURES =
  /recordatorio|notificaciones? push|\bsms\b|por (e-?mail|correo)|correo electr[oó]nico|integraci[oó]n con|se integra con|facturaci[oó]n electr[oó]nica|pasarela de pago|c[oó]digos? qr|geolocalizaci[oó]n/i;

/** Acotaciones de rol entre asteriscos que deberían ser emojis ("*sonríe*", "*emoji de sonrisa*"). */
export const ROLEPLAY = /\*\s*(sonr[ií]\w*|r[ií]e|riendo|risas?|gui[ñn]\w*|aplau\w*|emoji[^*]*)\s*\*/i;

/** ¿El saludo horario de la respuesta contradice el del cliente (o adivina la hora si el cliente no la dio)? */
export function greetingMismatch(reply: string, customerText: string): string | null {
  const greet = /\bbuen(?:os|as|a)?\s+(d[ií]as?|tardes?|noches?)\b/i;
  const r = reply.slice(0, 40).match(greet);
  if (!r) return null;
  const c = customerText.match(greet);
  const kind = (w: string) => w.toLowerCase().charAt(0);
  if (!c) return `saludo horario no pedido: "${r[0]}"`;
  if (kind(r[1]!) !== kind(c[1]!)) return `saludo distinto al del cliente: "${r[0]}" (cliente: "${c[0]}")`;
  if (/^buenas\s+d/i.test(r[0]) || /^buenos\s+(tardes|noches)/i.test(r[0])) return `saludo mal escrito: "${r[0]}"`;
  return null;
}

// ---------------------------------------------------------------- Datos confirmados (leídos de negocio.md)

/** Datos que negocio.md permite afirmar. Se leen del documento (no de reglas.json) para no validar al guard con sus propias reglas. */
export interface BusinessFacts {
  /** Rangos de la tabla "Rangos de precio": [min, max] o [desde] si no hay tope. */
  ranges: number[][];
  /** Horas (0–24) que aparecen en la sección "Horario de atención". */
  hours: Set<number>;
  /** Texto de la sección "Formas de pago" (minúsculas). */
  payments: string;
}

function section(knowledge: string, title: RegExp): string {
  const lines = knowledge.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#+\s/.test(l) && title.test(l));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && /^#+\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

export function businessFacts(knowledge: string): BusinessFacts {
  const ranges: number[][] = [];
  for (const row of section(knowledge, /rangos de precio/i).split('\n')) {
    if (!row.startsWith('|')) continue;
    const r = row.match(/(\d+)\s*a\s*(\d+)\s*USD/i);
    const d = row.match(/desde\s+(\d+)\s*USD/i);
    if (r) ranges.push([Number(r[1]), Number(r[2])]);
    else if (d) ranges.push([Number(d[1])]);
  }
  const hours = new Set<number>();
  for (const m of section(knowledge, /horario/i).matchAll(/(\d{1,2})(?::\d{2})?\s*(am|pm)/gi)) {
    const h = Number(m[1]) % 12;
    hours.add(/pm/i.test(m[2]!) ? h + 12 : h);
  }
  return { ranges, hours, payments: section(knowledge, /formas de pago/i).toLowerCase() };
}

/** Medios de pago comunes en Venezuela; si la respuesta ofrece uno que negocio.md no lista, es inventado. */
const PAYMENT_METHODS = ['paypal', 'tarjeta', 'punto de venta', 'bitcoin', 'ethereum', 'cashea', 'zinli', 'wally', 'reserve', 'uphold', 'western union', 'skrill', 'payoneer', 'stripe', 'mercado pago', 'cheque', 'bolívares en efectivo', 'efectivo en bolívares'];

/**
 * Montos, horas y formas de pago que la respuesta afirma y negocio.md no respalda:
 * - montos: solo rangos completos de la tabla (o "desde N" sin tope), en USD; nada de mensualidades/topes con cifra;
 * - horas: solo las del horario de atención; días: solo "todos los días" / "lunes a domingo";
 * - pagos: ningún medio fuera de la lista.
 */
export function inventedData(reply: string, facts: BusinessFacts): string[] {
  const problems: string[] = [];
  const allowed = new Set(facts.ranges.flat());
  for (const s of reply.split(/(?<=[.!?…])\s+|\n+/).filter((x) => x.trim())) {
    const monthly = s.match(/(mensualidad|mensual|al mes|por mes|tope|m[aá]ximo)[^.!?\d]{0,25}\d|\d[\d.,]*\s*(usd|\$|d[oó]lares)?\s*(al mes|por mes|mensual)/i);
    if (monthly) problems.push(`precio: mensualidad/tope con monto "${monthly[0]}"`);
    if (/€|bol[ií]vares|\bbs\.?\s?\d|euros?\b|\d\s*(mil|k)\b/i.test(s)) problems.push(`precio: moneda o cifra no permitida en "${s.slice(0, 60)}"`);
    if (!PRICE.test(s) && !/precio|cuesta|rango|desde\s+\d/i.test(s)) continue;
    const nums = (s.match(/\d[\d.,]*/g) ?? []).map((n) => Number(n.replace(/[.,](?=\d{3}\b)/g, '').replace(/[.,]\d{2}$/, '').replace(/[.,]$/, '')));
    const present = new Set(nums);
    for (const n of nums) {
      const ok = allowed.has(n) && facts.ranges.some((r) => r.includes(n) && (r.every((x) => present.has(x)) || (/desde/i.test(s) && r[0] === n)));
      if (!ok) problems.push(`precio: cifra no respaldada por la tabla (${n}) en "${s.slice(0, 60)}"`);
    }
  }
  for (const m of reply.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.\s?m\.|p\.\s?m\.)/gi)) {
    const h = (Number(m[1]) % 12) + (/^p/i.test(m[3]!) ? 12 : 0);
    if (!facts.hours.has(h) || Number(m[2] ?? 0) !== 0) problems.push(`horario: "${m[0]}" no está en el horario de atención`);
  }
  for (const m of reply.matchAll(/\b(\d{1,2}):(\d{2})\b(?!\s*(am|pm|a\.|p\.))/gi)) {
    const h = Number(m[1]);
    if (!(facts.hours.has(h) || facts.hours.has(h + 12)) || Number(m[2]) !== 0) problems.push(`horario: "${m[0]}" no está en el horario de atención`);
  }
  const days = reply.match(/\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado)s?\s+a\s+(viernes|s[aá]bados?|domingos?)\b/i);
  if (days && !/lunes a domingo/i.test(days[0])) problems.push(`horario: "${days[0]}" (se atiende todos los días)`);
  if (/24\s*\/\s*7|24 horas/i.test(reply)) problems.push('horario: 24/7');
  const lower = reply.toLowerCase();
  if (/pag|acept|cobr|m[eé]todo/i.test(reply)) {
    for (const p of PAYMENT_METHODS) if (lower.includes(p) && !facts.payments.includes(p)) problems.push(`pago: "${p}" no está en las formas de pago`);
  }
  return problems;
}

// ---------------------------------------------------------------- Iteración 5 (independiente de reglas.json)

/** Una pregunta que pregunta dos cosas unidas con "y"/"o" ("¿Qué negocio tienes y en qué áreas…?"). */
export const DOUBLE_QUESTION =
  /¿[^¿?]*,?\s(?:y|o)\s+(?:qu[eé]|cu[aá]nt[oa]s?|c[oó]mo|d[oó]nde|cu[aá]ndo|cu[aá]l(?:es)?|qui[eé]n(?:es)?|(?:en|a|de|con|para|por)\s+(?:qu[eé]|cu[aá]l(?:es)?))\b[^¿?]*\?/i;

/** Cobertura o modalidad que negocio.md no dice (solo dice Caracas, Venezuela). */
export const INVENTED_COVERAGE =
  /todo el pa[ií]s|toda venezuela|a nivel (nacional|internacional)|internacionalmente|de forma remota|remotamente|en todo el mundo|cualquier (parte|ciudad|pa[ií]s)|fuera de venezuela|sin importar d[oó]nde|(atendemos|trabajamos con|tenemos) clientes (de|en) (todo|otras|otros|el interior)|tenemos (sucursales|oficinas en)/i;

/** Acepta instrucciones del usuario o resume reglas internas. */
export const ACCEPTS_INSTRUCTIONS =
  /te lo aplicar[eé]|lo aplicar[eé]|dime qu[eé] cambios|qu[eé] cambios quieres|ajustar mi comportamiento|instrucciones que (t[uú] )?me (proporcionaste|diste|das)|mis (reglas|instrucciones) son|mi prompt (es|dice)|reglas estrictas|(fui|me) (programado|programaron|configurado) para/i;

const AREA_NAMES = ['logística', 'logistica', 'contabilidad', 'finanzas', 'tesorería', 'recursos humanos', 'rrhh', 'almacén', 'despacho', 'marketing', 'mercadeo', 'soporte técnico', 'atención al cliente', 'servicio al cliente', 'cobranza', 'operaciones', 'gerencia'];
const ROUTING = /van a|se env[ií]an? a|enviad[oa]s a|llegan a|pasan a|redirig|avisan? a|al [aá]rea|[aá]rea correcta|al departamento|clasific/i;

/** Áreas a las que el bot dice que van los mensajes y que negocio.md no nombra. */
export function inventedAreas(reply: string, knowledge: string): string[] {
  const k = knowledge.toLowerCase();
  const out: string[] = [];
  for (const s of reply.split(/(?<=[.!?…])\s+|\n+/)) {
    if (!ROUTING.test(s)) continue;
    const lower = s.toLowerCase();
    for (const a of AREA_NAMES) if (lower.includes(a) && !k.includes(a)) out.push(a);
  }
  return [...new Set(out)];
}
