import { type GuardRules, normalize, type PrecioServicio, type PreciosRules } from './rules.js';

/** Un servicio detectado en el texto del cliente, con las palabras que lo identificaron. */
export interface ServicioDetectado {
  servicio: PrecioServicio;
  /** Frases del cliente que lo identificaron (normalizadas), para el motivo. */
  menciones: string[];
}

interface Span {
  start: number;
  end: number;
  phrase: string;
  servicios: string[];
}

/** Posiciones (en palabras) donde aparece `phrase` dentro de `words`. */
function findPhrase(words: string[], phrase: string): number[] {
  const p = normalize(phrase).split(' ').filter(Boolean);
  const out: number[] = [];
  if (!p.length) return out;
  for (let i = 0; i + p.length <= words.length; i++) {
    if (p.every((w, k) => words[i + k] === w)) out.push(i);
  }
  return out;
}

/**
 * Servicios de la tabla de precios que menciona el texto. La frase más larga gana y las frases no se solapan:
 * "app web" es App web (no también "web" ni "app"); "app" sola es ambigua (App web y App móvil).
 * Se devuelven en el orden de la tabla.
 */
export function detectServicios(customerText: string, precios: PreciosRules): ServicioDetectado[] {
  const words = normalize(customerText).split(' ').filter(Boolean);
  const candidates: Span[] = [];
  const add = (phrase: string, servicios: string[]) => {
    const len = normalize(phrase).split(' ').filter(Boolean).length;
    for (const start of findPhrase(words, phrase)) candidates.push({ start, end: start + len, phrase: normalize(phrase), servicios });
  };
  for (const sv of precios.servicios) for (const k of sv.keywords) add(k, [sv.id]);
  for (const a of precios.ambiguos ?? []) for (const k of a.keywords) add(k, a.servicios);

  candidates.sort((x, y) => y.end - y.start - (x.end - x.start) || x.start - y.start);
  const taken: Span[] = [];
  for (const c of candidates) {
    if (taken.some((t) => c.start < t.end && t.start < c.end)) continue;
    taken.push(c);
  }
  const menciones = new Map<string, string[]>();
  for (const t of taken.sort((x, y) => x.start - y.start)) {
    for (const id of t.servicios) {
      const list = menciones.get(id) ?? [];
      if (!list.includes(t.phrase)) list.push(t.phrase);
      menciones.set(id, list);
    }
  }
  return precios.servicios.filter((sv) => menciones.has(sv.id)).map((servicio) => ({ servicio, menciones: menciones.get(servicio.id)! }));
}

function joinList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} y ${items.at(-1)}`;
}

/** Respuesta fija con los rangos referenciales (uno o varios servicios), la nota y el aviso de handoff. */
export function priceReply(detectados: ServicioDetectado[], precios: PreciosRules): string {
  const intro = precios.intro ?? 'Como referencia';
  const body =
    detectados.length === 1
      ? `${intro}, ${detectados[0]!.servicio.nombre ?? detectados[0]!.servicio.fila}: ${detectados[0]!.servicio.rango}.`
      : `${intro}:\n${detectados.map((d) => `- ${d.servicio.nombre ?? d.servicio.fila}: ${d.servicio.rango}`).join('\n')}\n`;
  return `${body}${detectados.length === 1 ? ' ' : ''}${precios.nota} ${precios.cierre}`;
}

/** Motivo fiel: lo que el cliente nombró (sus palabras) y qué rango se le dio. */
export function priceMotivo(prefix: string, detectados: ServicioDetectado[], precios: PreciosRules, quotes: string[]): string {
  const menciones = [...new Set(detectados.flatMap((d) => d.menciones))].map((m) => `«${m}»`);
  const dado = precios.motivo.replace('{servicios}', joinList(detectados.map((d) => d.servicio.nombre ?? d.servicio.fila)));
  return `${prefix} (${joinList(menciones)}). ${dado}: ${quotes.map((q) => `«${q}»`).join(' · ')}`;
}

/** ¿El último mensaje del bot fue la pregunta "¿Para qué producto o servicio necesitas el precio?"? */
export function askedForService(lastBotText: string | undefined, precios: PreciosRules): boolean {
  if (!lastBotText) return false;
  return normalize(lastBotText).includes(normalize(precios.preguntaSinServicio));
}

/** Cifras (USD) que aparecen en la tabla de precios: las únicas que una respuesta puede mencionar. */
export function allowedAmounts(rules: GuardRules): Set<number> {
  return new Set((rules.precios?.servicios ?? []).flatMap((sv) => sv.montos ?? []));
}
