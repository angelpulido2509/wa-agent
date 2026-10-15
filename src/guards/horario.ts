import type { HorarioRules } from './rules.js';

/** Hora local (0–23, con minutos como fracción) en la zona del negocio. */
export function localHour(now: Date, zona: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zona, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (h % 24) + m / 60;
}

/** ¿Estamos fuera del horario de atención? (antes de `abre` o desde `cierra`, hora local). */
export function isOffHours(now: Date, horario: HorarioRules): boolean {
  const h = localHour(now, horario.zona);
  if (horario.abre === undefined || horario.cierra === undefined) return false;
  return h < horario.abre || h >= horario.cierra;
}

/** "te escribirá por aquí en breve", "en breve te escriben por aquí"… (el aviso del handoff). */
const NOTICE = /(?:\b(?:en breve|enseguida|muy pronto|pronto),?\s+)?\b(te\s+(?:escribir[áa]n?|escriben|contactar[áa]n?|responder[áa]n?))(\s+por\s+aqu[ií])?(?:\s+(?:en breve|enseguida|muy pronto|pronto|en unos minutos|en un momento))?/i;

/**
 * Fuera de horario, el aviso de handoff dice desde cuándo escribirá una persona:
 * "te escribirá por aquí" → "te escribirá por aquí a partir de las 8:00 am (hora de Caracas)".
 * Si el texto no tiene un aviso reconocible, se agrega una oración al final.
 */
export function offHoursNotice(reply: string, horario: HorarioRules): string {
  if (reply.includes(horario.avisoFueraDeHorario)) return reply;
  const m = reply.match(NOTICE);
  if (m && m.index !== undefined) {
    const verb = m[1]!;
    const replacement = `${verb}${m[2] ?? ''} ${horario.avisoFueraDeHorario}`;
    const before = reply.slice(0, m.index);
    // "En breve te escriben…" al inicio de oración: la nueva oración empieza con mayúscula.
    const startsSentence = /(^|[.!?…]\s*|\n\s*)$/.test(before);
    const fixed = startsSentence ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;
    return before + fixed + reply.slice(m.index + m[0].length);
  }
  const sep = /[.!?…]$/u.test(reply.trim()) || /\p{Extended_Pictographic}$/u.test(reply.trim()) ? ' ' : '. ';
  return `${reply.trim()}${sep}Como estamos fuera de horario, una persona del equipo te escribirá ${horario.avisoFueraDeHorario}.`;
}
