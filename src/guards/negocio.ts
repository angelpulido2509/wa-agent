import { type GuardRules, normalize, parseRules, RulesError } from './rules.js';

/**
 * FUENTE ÚNICA DE VERDAD: los rangos de precio, el horario y las formas de pago se leen de negocio.md.
 * reglas.json solo dice CÓMO detectarlos (palabras clave) y qué fila de la tabla corresponde a cada servicio;
 * los textos de las respuestas usan marcadores ({horario}, {formasDePago}, {abre}) que se completan desde aquí.
 * Si una fila de reglas.json no existe en negocio.md (o al revés), falla con un error claro.
 */

export interface RangoNegocio {
  /** Texto tal como se muestra: "de 100 a 600 USD" / "desde 100 USD, con una mensualidad variable…". */
  rango: string;
  montos: number[];
  sinTope: boolean;
}

export interface BusinessData {
  /** Filas de la tabla "Rangos de precio": nombre del servicio → rango. */
  precios: Map<string, RangoNegocio>;
  horario: { abre: number; cierra: number; texto: string; abreTexto: string } | null;
  /** "efectivo en divisas, Zelle, Binance (USDT o USDC), pago móvil o transferencia" */
  formasDePago: string | null;
}

function section(knowledge: string, title: RegExp): string | null {
  const lines = knowledge.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#+\s/.test(l) && title.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^#+\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

function to24(h: number, ampm: string): number {
  return (h % 12) + (/^p/i.test(ampm) ? 12 : 0);
}

export function parseBusinessData(knowledge: string): BusinessData {
  const precios = new Map<string, RangoNegocio>();
  for (const row of (section(knowledge, /rangos de precio/i) ?? '').split('\n')) {
    const cells = row.split('|').map((c) => c.trim());
    if (cells.length < 4 || /^-+$/.test(cells[1]!) || /^servicio$/i.test(cells[1]!)) continue;
    const [, nombre, valor] = cells as [string, string, string];
    const r = valor.match(/^(\d+)\s*a\s*(\d+)\s*USD$/i);
    const d = valor.match(/^desde\s+(\d+)\s*USD/i);
    if (r) precios.set(nombre, { rango: `de ${r[1]} a ${r[2]} USD`, montos: [Number(r[1]), Number(r[2])], sinTope: false });
    else if (d) precios.set(nombre, { rango: valor.replace(/\s*\([^)]*\)\s*$/, '').trim(), montos: [Number(d[1])], sinTope: true });
    else throw new RulesError(`negocio.md: no se entiende el rango de "${nombre}": "${valor}"`);
  }

  let horario: BusinessData['horario'] = null;
  const h = section(knowledge, /horario/i);
  const m = h?.match(/-\s*(.+?),?\s+de\s+(\d{1,2}):(\d{2})\s*(am|pm)\s+a\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (m) {
    const [, dias, h1, m1, ap1, h2, m2, ap2] = m as unknown as string[];
    horario = {
      abre: to24(Number(h1), ap1!),
      cierra: to24(Number(h2), ap2!),
      texto: `${dias!.charAt(0).toLowerCase()}${dias!.slice(1)} de ${h1}:${m1} ${ap1!.toLowerCase()} a ${h2}:${m2} ${ap2!.toLowerCase()}`,
      abreTexto: `${h1}:${m1} ${ap1!.toLowerCase()}`,
    };
  }

  const p = section(knowledge, /formas de pago/i)?.split('\n').find((l) => /^\s*-\s+/.test(l));
  const formasDePago = p ? p.replace(/^\s*-\s+/, '').replace(/\.\s*$/, '').replace(/^\p{Lu}/u, (c) => c.toLowerCase()) : null;
  return { precios, horario, formasDePago };
}

function fill(text: string, data: BusinessData, where: string): string {
  return text.replace(/\{(horario|formasDePago|abre)\}/g, (_, key: string) => {
    const value = key === 'horario' ? data.horario?.texto : key === 'abre' ? data.horario?.abreTexto : data.formasDePago;
    if (!value) throw new RulesError(`${where} usa {${key}} pero negocio.md no tiene ese dato`);
    return value;
  });
}

/**
 * Completa las reglas con los datos de negocio.md (sin modificar el objeto original).
 * Valida en ambos sentidos: cada servicio de reglas.json apunta a una fila de la tabla y cada fila tiene servicio.
 */
export function applyBusinessData(rules: GuardRules, knowledge: string): GuardRules {
  const data = parseBusinessData(knowledge);
  const out: GuardRules = structuredClone(rules);
  for (const intent of out.pre.intents) intent.respuesta = fill(intent.respuesta, data, `pre.intents[${intent.id}].respuesta`);
  if (out.pre.medios) out.pre.medios.respuesta = fill(out.pre.medios.respuesta, data, 'pre.medios.respuesta');

  if (out.precios) {
    const filas = new Map([...data.precios.keys()].map((k) => [normalize(k), k]));
    const usadas = new Set<string>();
    for (const sv of out.precios.servicios) {
      const fila = filas.get(normalize(sv.fila));
      if (!fila) throw new RulesError(`precios.servicios[${sv.id}].fila "${sv.fila}" no está en la tabla "Rangos de precio" de negocio.md`);
      usadas.add(fila);
      const r = data.precios.get(fila)!;
      sv.nombre = fila;
      sv.rango = r.rango;
      sv.montos = r.montos;
      sv.sinTope = r.sinTope;
    }
    const sinServicio = [...data.precios.keys()].filter((k) => !usadas.has(k));
    if (sinServicio.length) throw new RulesError(`negocio.md tiene rangos sin servicio en reglas.json (precios.servicios): ${sinServicio.join(', ')}`);
    for (const key of ['nota', 'cierre', 'preguntaSinServicio', 'sinServicioTrasPregunta'] as const) {
      out.precios[key] = fill(out.precios[key], data, `precios.${key}`);
    }
  }

  if (out.horario) {
    if (!data.horario) throw new RulesError('reglas.json tiene "horario" pero negocio.md no tiene la sección "Horario de atención"');
    out.horario.abre = data.horario.abre;
    out.horario.cierra = data.horario.cierra;
    out.horario.avisoFueraDeHorario = fill(out.horario.avisoFueraDeHorario, data, 'horario.avisoFueraDeHorario');
  }
  return out;
}

/** reglas.json (texto) + negocio.md → reglas listas para usar. */
export function parseBusinessRules(rawRules: string, knowledge: string): GuardRules {
  return applyBusinessData(parseRules(rawRules), knowledge);
}
