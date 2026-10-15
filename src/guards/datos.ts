import { allowedAmounts, detectServicios } from './precios.js';
import { containsPhrase, type GuardRules, normalize } from './rules.js';

/**
 * Validación de los DATOS que el bot puede afirmar: montos (solo los de la tabla de precios, en USD),
 * horas (solo las del horario de atención) y formas de pago (nunca las que no se aceptan).
 * Sin las secciones correspondientes en reglas.json, cualquier monto u hora se bloquea (comportamiento previo).
 */

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- Montos ----------

const LEGACY_PRICE = [
  /(?:us\$|\$|€|£)\s?\d/i,
  /\b\d[\d.,]*\s*(?:usd|us\$|d[oó]lares|bol[ií]vares|bs\.?|eur|euros|\$|€)/i,
  /\b(?:usd|bs\.?)\s?\d/i,
  /\b\d[\d.,]*\s*(?:mil|k)\b/i,
];
const CURRENCY = /us\$|\$|€|£|\busd\b|d[oó]lar(?:es)?|bol[ií]var(?:es)?|\bbs\.?\s?\d|\beur\b|euros?/i;
const OTHER_CURRENCY = /€|£|bol[ií]var(?:es)?|\bbs\.?\s?\d|\beur\b|euros?/i;
const PRICE_WORDS = /precio|cuesta|cuestan|costar|costo|vale|valen|cobramos|cobra|rango|presupuesto|inversi[oó]n|tarifa|desde\s+\d/i;
const THOUSANDS = /\b\d[\d.,]*\s*(?:mil|k)\b/i;
/** Mensualidad o tope con cifra: "mensualidad de 30 USD", "50 $ al mes", "tope de 900". */
const MONTHLY_FIGURE = [
  /(?:mensualidad(?:es)?|mensual(?:es)?|al mes|por mes|cada mes|tope|m[aá]ximo)[^.!?\n\d]{0,25}\d/i,
  /\d[\d.,]*\s*(?:usd|us\$|\$|d[oó]lares)?\s*(?:al mes|por mes|mensual(?:es)?|cada mes)\b/i,
];
const NUMBER = /\d[\d.,]*/g;

/** "2.500" / "2,500" → 2500; "100.00" → 100. */
export function parseAmount(raw: string): number {
  let s = raw.replace(/[.,]$/, '');
  s = s.replace(/[.,]\d{2}$/, '');
  s = s.replace(/[.,](?=\d{3}\b)/g, '');
  return Number(s.replace(/[.,]/g, ''));
}

/** Devuelve la cifra o expresión no permitida, o null. */
export function priceViolation(text: string, rules: GuardRules): string | null {
  if (!rules.precios) {
    for (const re of LEGACY_PRICE) {
      const m = text.match(re);
      if (m) return m[0];
    }
    return null;
  }
  const allowed = allowedAmounts(rules);
  for (const sentence of splitSentences(text)) {
    for (const re of MONTHLY_FIGURE) {
      const m = sentence.match(re);
      if (m) return `mensualidad o tope con monto: "${m[0]}"`;
    }
    const thousands = sentence.match(THOUSANDS);
    if (thousands) return thousands[0];
    const other = sentence.match(OTHER_CURRENCY);
    if (other) return `moneda no permitida: "${other[0]}"`;
    if (!CURRENCY.test(sentence) && !PRICE_WORDS.test(sentence)) continue;
    const amounts = (sentence.match(NUMBER) ?? []).map(parseAmount).filter((n) => Number.isFinite(n));
    if (!amounts.length) continue;
    const bad = amounts.find((n) => !allowed.has(n));
    if (bad !== undefined) return `monto fuera de la tabla: ${bad}`;
    // Cada cifra debe ser parte de un rango COMPLETO de la tabla ("de 300 a 900 USD") o un "desde N"
    // de un servicio sin tope. Una cifra suelta ("ronda los 300 dólares") es una estimación inventada.
    const present = new Set(amounts);
    const desde = /\bdesde\b/i.test(sentence);
    const loose = amounts.find(
      (n) =>
        !rules.precios!.servicios.some(
          (sv) => (sv.montos ?? []).includes(n) && ((sv.montos ?? []).every((m) => present.has(m)) || (desde && sv.montos?.[0] === n)),
        ),
    );
    if (loose !== undefined) return `cifra suelta, no es un rango de la tabla: ${loose}`;
    // Si la oración nombra un único servicio, las cifras deben ser las de ESE servicio.
    const servicios = detectServicios(sentence, rules.precios);
    if (servicios.length === 1) {
      const own = new Set(servicios[0]!.servicio.montos ?? []);
      const wrong = amounts.find((n) => !own.has(n));
      if (wrong !== undefined) return `monto de otro servicio para ${servicios[0]!.servicio.nombre}: ${wrong}`;
    }
  }
  return null;
}

// ---------- Horas ----------

const LEGACY_HOUR = [
  /\b\d{1,2}:\d{2}\s*(?:a\.?\s?m\.?|p\.?\s?m\.?|h|hrs?|horas)?/i,
  /\b\d{1,2}\s*(?:a\.\s?m\.?|p\.\s?m\.?|am|pm)\b/i,
  // "de 8 a 5" es horario; "de 5 a 10 personas" no.
  /\bde\s+\d{1,2}\s*(?:a|hasta)\s+\d{1,2}\b(?!\s*(?:personas|empleados|trabajadores|usuarios|clientes|sucursales|tiendas|productos|pedidos|a[nñ]os|meses|semanas|d[ií]as))/i,
  /\b(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?)\s+a\s+(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?)\b/i,
  /\b24\s*\/\s*7\b|\b24\s+horas\b/i,
];
const AMPM = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|am|pm)(?![\p{L}])/giu;
const HHMM = /\b(\d{1,2}):(\d{2})\b(?!\s*(?:a\.?\s?m|p\.?\s?m|am|pm))/gi;
const HOUR_RANGE =
  /\bde\s+(\d{1,2})\s*(?:a|hasta)\s+(\d{1,2})\b(?!\s*(?:[:.]\d|personas|empleados|trabajadores|usuarios|clientes|sucursales|tiendas|productos|pedidos|a[nñ]os|meses|semanas|d[ií]as|usd|\$|d[oó]lares))/gi;
const DAY = '(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?)';
const DAY_RANGE = new RegExp(`\\b(?:de\\s+)?${DAY}\\s+a\\s+${DAY}\\b`, 'i');
const ALWAYS = /\b24\s*\/\s*7\b|\b24\s+horas\b/i;

/** Devuelve la hora o expresión que no coincide con el horario real, o null. */
export function hourViolation(text: string, rules: GuardRules): string | null {
  const horario = rules.horario;
  if (!horario) {
    for (const re of LEGACY_HOUR) {
      const m = text.match(re);
      if (m) return m[0];
    }
    return null;
  }
  const allowed = new Set([horario.abre, horario.cierra]);
  const ok24 = (h: number, min: number) => min === 0 && allowed.has(h);
  // Sin am/pm ("9", "9:00"), vale si la hora coincide en 24 h o en 12 h.
  const okAmbiguous = (h: number, min: number) => min === 0 && (allowed.has(h) || allowed.has(h + 12) || allowed.has(h - 12));

  const always = text.match(ALWAYS);
  if (always) return always[0];
  const days = text.match(DAY_RANGE);
  if (days && !/lunes\s+a\s+domingo/i.test(days[0])) return `días distintos al horario: "${days[0]}"`;
  for (const m of text.matchAll(AMPM)) {
    const raw = Number(m[1]);
    const min = Number(m[2] ?? 0);
    const pm = /^p/i.test(m[3]!);
    const h = pm ? (raw % 12) + 12 : raw % 12;
    if (!ok24(h, min)) return m[0];
  }
  for (const m of text.matchAll(HHMM)) {
    if (!okAmbiguous(Number(m[1]), Number(m[2]))) return m[0];
  }
  for (const m of text.matchAll(HOUR_RANGE)) {
    if (!okAmbiguous(Number(m[1]), 0) || !okAmbiguous(Number(m[2]), 0)) return m[0];
  }
  return null;
}

// ---------- Formas de pago ----------

const PAYMENT_CONTEXT = /pag|aceptamos|acepta|cobr|m[eé]todo|abon|zelle|binance|transferencia|efectivo/i;

/** Medio de pago no aceptado mencionado en una oración sobre pagos, o null. */
export function paymentViolation(text: string, rules: GuardRules): string | null {
  const banned = rules.post.pagosNoAceptados ?? [];
  if (!banned.length) return null;
  for (const sentence of splitSentences(text)) {
    if (!PAYMENT_CONTEXT.test(sentence)) continue;
    const norm = normalize(sentence);
    const hit = banned.find((b) => containsPhrase(norm, b));
    if (hit) return hit;
  }
  return null;
}
