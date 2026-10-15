import fs from 'node:fs/promises';

/** Minúsculas, sin tildes, signos → espacio. Así "¿Cuánto CUESTA?" y "cuanto cuesta" coinciden. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
}

/** ¿Aparece `phrase` como palabras completas dentro de `normalizedText`? */
export function containsPhrase(normalizedText: string, phrase: string): boolean {
  const p = normalize(phrase);
  return p.length > 0 && ` ${normalizedText} `.includes(` ${p} `);
}

export interface PreIntent {
  id: string;
  /**
   * "derivar" (por defecto): responde el texto fijo y pasa a una persona. "responder": solo responde.
   * "precios": responde con los rangos de `precios` según el servicio que mencione el cliente, y deriva.
   */
  accion?: 'derivar' | 'responder' | 'precios';
  /** Solo para "precios": sin servicio detectado, "preguntar" (por defecto) hace la pregunta; "seguir" ignora la intención. */
  sinServicio?: 'preguntar' | 'seguir';
  motivo: string;
  respuesta: string;
  keywords: string[];
  /** Cada combo: lista de grupos; debe aparecer al menos un término de cada grupo. */
  combos?: string[][][];
  exclude?: string[];
}

/** Regla de frases: basta una keyword, o un término de cada grupo de algún combo. */
export interface PhraseRule {
  keywords: string[];
  combos?: string[][][];
}

/** Devuelve la frase o combinación que coincide (texto ya normalizado), o null. */
export function matchPhraseRule(normalizedText: string, rule: PhraseRule): string | null {
  const keyword = rule.keywords.find((k) => containsPhrase(normalizedText, k));
  if (keyword) return keyword;
  for (const combo of rule.combos ?? []) {
    const hits = combo.map((group) => group.find((term) => containsPhrase(normalizedText, term)));
    if (hits.every(Boolean)) return hits.join(' + ');
  }
  return null;
}

/** Un servicio con su rango referencial (misma tabla que negocio.md). */
/**
 * Un servicio de la tabla de precios. En reglas.json solo van `id`, `fila` y `keywords`:
 * nombre, rango, montos y sinTope se completan desde negocio.md (applyBusinessData).
 */
export interface PrecioServicio {
  id: string;
  /** Nombre de la fila en la tabla "Rangos de precio" de negocio.md. */
  fila: string;
  /** (desde negocio.md) Nombre que se muestra. */
  nombre?: string;
  /** (desde negocio.md) Texto que se muestra: "de 100 a 600 USD". */
  rango?: string;
  /** (desde negocio.md) Cifras permitidas en las respuestas (en USD). */
  montos?: number[];
  /** (desde negocio.md) true: no hay tope publicado ("desde 100 USD" + mensualidad variable). */
  sinTope?: boolean;
  keywords: string[];
}

export interface PreciosRules {
  /** "Como referencia" (inicio de la respuesta). */
  intro?: string;
  servicios: PrecioServicio[];
  /** Palabras que no dicen cuál servicio (p. ej. "app" sola): se dan los rangos de todos los servicios listados. */
  ambiguos?: { keywords: string[]; servicios: string[] }[];
  /** "Es un rango referencial y el precio final depende del diagnóstico, que es gratis." */
  nota: string;
  /** Aviso de handoff al final de la respuesta de precio. */
  cierre: string;
  /** UNA pregunta cuando no se detecta el servicio. */
  preguntaSinServicio: string;
  /** Se agrega a la respuesta de precio cuando el mensaje trae otra consulta (que queda para la persona). */
  otraPregunta?: string;
  /** Si responde a "preguntaSinServicio" sin decir el servicio: se deriva con este texto. */
  sinServicioTrasPregunta: string;
  /** Plantilla del motivo; {servicios} = nombres de los servicios detectados. */
  motivo: string;
}

export interface HorarioRules {
  /** Zona IANA, p. ej. "America/Caracas". */
  zona: string;
  /** (desde negocio.md) Hora de apertura y de cierre (0–24, hora local de la zona). */
  abre?: number;
  cierra?: number;
  /** Se agrega al aviso de handoff fuera de horario: "a partir de las {abre} (hora de Caracas)". */
  avisoFueraDeHorario: string;
}

export interface GuardRules {
  pre: { intents: PreIntent[]; medios?: { respuesta: string } };
  precios?: PreciosRules;
  horario?: HorarioRules;
  /** voseo: formas que se bloquean (se comparan con tildes). */
  post: {
    techTerms: string[];
    voseo?: string[];
    /** Servicios de negocio.md: el primer mensaje ante un problema debe nombrar al menos uno. */
    servicios?: string[];
    /** Señales de que el cliente describe un problema operativo. */
    senalesProblema?: string[];
    /** Frases que afirman experiencia, clientes o casos (PENDIENTE en negocio.md): se bloquean. */
    experiencia?: PhraseRule;
    /** Ofertas por rubro en presente ("creamos … para panaderías"): se bloquean. Se evalúa por oración. */
    ofertaRubro?: PhraseRule;
    /** Acotaciones de rol ("*sonríe*") → emoji. Claves normalizadas; "_porDefecto" para "*emoji de …*" desconocidos. */
    acotaciones?: Record<string, string>;
    /** Frases con las que el cliente pregunta qué hace DevBull (primer mensaje → debe nombrarse un servicio). */
    preguntaServicios?: string[];
    /** Funciones concretas que no se deben prometer (salvo que estén en negocio.md). Se evalúa por oración. */
    funcionesPrometidas?: PhraseRule;
    /** Medios de pago que NO se aceptan: si una oración sobre pagos los menciona, se bloquea. */
    pagosNoAceptados?: string[];
    /** Frases que aceptan instrucciones del usuario o resumen reglas internas ("te lo aplicaré", "mis reglas son"). */
    instrucciones?: PhraseRule;
    /** Cobertura o modalidad no escrita en negocio.md ("todo el país", "de forma remota"). Se evalúa por oración. */
    cobertura?: PhraseRule;
    /** Áreas a las que se envían los mensajes que no están en negocio.md ("van a Logística"). Se evalúa por oración. */
    areas?: PhraseRule;
    respuestaSegura: string;
  };
}

export class RulesError extends Error {
  override name = 'RulesError';
}

function assertStrings(value: unknown, where: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new RulesError(`${where} debe ser una lista de textos`);
  }
}

/** Valida la estructura para que un error de edición en reglas.json falle claro, no en silencio. */
export function parseRules(raw: string): GuardRules {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new RulesError(`reglas.json no es JSON válido: ${(err as Error).message}`);
  }
  const d = data as Partial<GuardRules>;
  if (!d.pre || !Array.isArray(d.pre.intents)) throw new RulesError('reglas.json: falta pre.intents');
  for (const [i, intent] of d.pre.intents.entries()) {
    const where = `pre.intents[${i}]`;
    for (const key of ['id', 'motivo', 'respuesta'] as const) {
      if (typeof intent[key] !== 'string' || !intent[key].trim()) throw new RulesError(`${where}.${key} es obligatorio`);
    }
    if (intent.accion !== undefined && !['derivar', 'responder', 'precios'].includes(intent.accion)) {
      throw new RulesError(`${where}.accion debe ser "derivar", "responder" o "precios"`);
    }
    if (intent.sinServicio !== undefined && !['preguntar', 'seguir'].includes(intent.sinServicio)) {
      throw new RulesError(`${where}.sinServicio debe ser "preguntar" o "seguir"`);
    }
    if (intent.accion === 'precios' && !d.precios) throw new RulesError(`${where}: "accion": "precios" requiere la sección precios`);
    assertStrings(intent.keywords, `${where}.keywords`);
    if (intent.exclude !== undefined) assertStrings(intent.exclude, `${where}.exclude`);
    for (const [c, combo] of (intent.combos ?? []).entries()) {
      if (!Array.isArray(combo) || combo.length === 0) throw new RulesError(`${where}.combos[${c}] vacío`);
      combo.forEach((group, g) => assertStrings(group, `${where}.combos[${c}][${g}]`));
    }
  }
  if (d.pre.medios !== undefined && (typeof d.pre.medios.respuesta !== 'string' || !d.pre.medios.respuesta.trim())) {
    throw new RulesError('pre.medios.respuesta debe ser un texto');
  }
  if (!d.post) throw new RulesError('reglas.json: falta post');
  assertStrings(d.post.techTerms, 'post.techTerms');
  if (d.post.voseo !== undefined) assertStrings(d.post.voseo, 'post.voseo');
  if (d.post.servicios !== undefined) assertStrings(d.post.servicios, 'post.servicios');
  if (d.post.senalesProblema !== undefined) assertStrings(d.post.senalesProblema, 'post.senalesProblema');
  if (d.post.preguntaServicios !== undefined) assertStrings(d.post.preguntaServicios, 'post.preguntaServicios');
  if (d.post.pagosNoAceptados !== undefined) assertStrings(d.post.pagosNoAceptados, 'post.pagosNoAceptados');
  if (d.precios !== undefined) {
    const p = d.precios;
    for (const key of ['nota', 'cierre', 'preguntaSinServicio', 'sinServicioTrasPregunta', 'motivo'] as const) {
      if (typeof p[key] !== 'string' || !p[key].trim()) throw new RulesError(`precios.${key} es obligatorio`);
    }
    if (!Array.isArray(p.servicios) || p.servicios.length === 0) throw new RulesError('precios.servicios debe ser una lista');
    for (const [i, sv] of p.servicios.entries()) {
      const where = `precios.servicios[${i}]`;
      for (const key of ['id', 'fila'] as const) {
        if (typeof sv[key] !== 'string' || !sv[key].trim()) throw new RulesError(`${where}.${key} es obligatorio`);
      }
      for (const key of ['rango', 'montos'] as const) {
        if (sv[key] !== undefined) throw new RulesError(`${where}.${key} no va en reglas.json: se lee de negocio.md (fuente única)`);
      }
      assertStrings(sv.keywords, `${where}.keywords`);
    }
    const ids = new Set(p.servicios.map((sv) => sv.id));
    for (const [i, a] of (p.ambiguos ?? []).entries()) {
      assertStrings(a.keywords, `precios.ambiguos[${i}].keywords`);
      assertStrings(a.servicios, `precios.ambiguos[${i}].servicios`);
      const unknown = a.servicios.filter((id) => !ids.has(id));
      if (unknown.length) throw new RulesError(`precios.ambiguos[${i}]: servicios desconocidos: ${unknown.join(', ')}`);
    }
  }
  if (d.horario !== undefined) {
    const h = d.horario;
    if (typeof h.zona !== 'string' || typeof h.avisoFueraDeHorario !== 'string') throw new RulesError('horario.zona y horario.avisoFueraDeHorario son obligatorios');
    if (h.abre !== undefined || h.cierra !== undefined) {
      throw new RulesError('horario.abre / horario.cierra no van en reglas.json: se leen de negocio.md (fuente única)');
    }
  }
  for (const key of ['experiencia', 'ofertaRubro', 'funcionesPrometidas', 'instrucciones', 'cobertura', 'areas'] as const) {
    const rule = d.post[key];
    if (rule === undefined) continue;
    assertStrings(rule.keywords, `post.${key}.keywords`);
    for (const [c, combo] of (rule.combos ?? []).entries()) {
      if (!Array.isArray(combo) || combo.length === 0) throw new RulesError(`post.${key}.combos[${c}] vacío`);
      combo.forEach((group, g) => assertStrings(group, `post.${key}.combos[${c}][${g}]`));
    }
  }
  if (d.post.acotaciones !== undefined) {
    const a = d.post.acotaciones as unknown;
    if (typeof a !== 'object' || a === null || Object.values(a).some((v) => typeof v !== 'string')) {
      throw new RulesError('post.acotaciones debe ser un objeto { acotación: emoji }');
    }
  }
  if (typeof d.post.respuestaSegura !== 'string' || !d.post.respuestaSegura.trim()) {
    throw new RulesError('post.respuestaSegura es obligatorio');
  }
  return d as GuardRules;
}

export async function loadRules(path: string): Promise<GuardRules> {
  return parseRules(await fs.readFile(path, 'utf8'));
}

/** Frases de una PhraseRule sin las que sí aparecen en negocio.md (lo que está escrito ahí se puede decir). */
export function withoutKnown(rule: PhraseRule | undefined, knowledge: string): PhraseRule | null {
  if (!rule) return null;
  const normKnowledge = normalize(knowledge);
  const keywords = rule.keywords.filter((k) => !containsPhrase(normKnowledge, k));
  return keywords.length || rule.combos?.length ? { keywords, combos: rule.combos } : null;
}
