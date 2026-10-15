import type { LlmMessage, LlmProvider, LlmRequest, LlmResponse } from './types.js';

/**
 * Proveedor de PRUEBAS: respuestas fijas y deterministas, sin red ni costo.
 * Sirve para probar de punta a punta el gateway de WhatsApp (debounce, delay, pausa, handoff, avisos).
 * Nunca debe atender clientes reales: loadConfig impide arrancarlo con TEST_MODE=false.
 */

export interface StubOptions {
  /** Regex (sin mayúsculas): si el último mensaje del cliente coincide, simula la tool transferir_a_humano. */
  handoffPattern: string;
  /** Se llama en cada respuesta para dejarla marcada en los logs con [STUB]. */
  log?: (message: string, data: Record<string, unknown>) => void;
}

export const STUB_REPLIES = {
  /** Incluye un servicio de negocio.md y una sola pregunta, así pasa los controles como una respuesta real. */
  default: (count: number) =>
    `Gracias por escribir a DevBull. Esta es una respuesta de prueba: recibí ${count} mensaje${count === 1 ? '' : 's'} tuyo${count === 1 ? '' : 's'}. ` +
    'Ayudamos con software a medida y automatización. ¿Qué proceso te gustaría mejorar?',
  afterHandoff: 'Listo, una persona del equipo te escribirá por aquí en breve.',
  handoffBlocked:
    'Gracias por escribir a DevBull. Esta es una respuesta de prueba: el control no permitió transferir en el primer mensaje. ' +
    'Ayudamos con software a medida y automatización. ¿Qué proceso te gustaría mejorar?',
} as const;

function lastOf<T extends LlmMessage['role']>(messages: LlmMessage[], role: T): Extract<LlmMessage, { role: T }> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === role) return m as Extract<LlmMessage, { role: T }>;
  }
  return undefined;
}

export class StubProvider implements LlmProvider {
  readonly name = 'stub' as const;
  readonly model = 'stub';
  private readonly pattern: RegExp;
  private calls = 0;

  constructor(private readonly opts: StubOptions) {
    this.pattern = new RegExp(opts.handoffPattern, 'i');
  }

  async chat(req: LlmRequest): Promise<LlmResponse> {
    this.calls++;
    const last = req.messages.at(-1);

    // Segunda vuelta del loop de tools: el agente devolvió el resultado de transferir_a_humano.
    if (last?.role === 'tool') {
      const blocked = last.isError === true;
      return this.reply(blocked ? STUB_REPLIES.handoffBlocked : STUB_REPLIES.afterHandoff, blocked ? 'handoff-bloqueado' : 'post-handoff');
    }

    const user = lastOf(req.messages, 'user');
    const text = user?.content ?? '';
    const tool = req.tools.find((t) => t.name === 'transferir_a_humano');
    if (tool && this.pattern.test(text)) {
      const call = { id: `stub_call_${this.calls}`, name: tool.name, input: { motivo: `«${text.slice(0, 120)}»` } }; // solo lo que escribió el cliente: pasa la validación de motivos
      this.opts.log?.('[STUB] simula tool call transferir_a_humano', { patron: this.opts.handoffPattern });
      return { text: '', toolCalls: [call], stopReason: 'tool_use', usage: this.usage() };
    }

    // Los mensajes de una ráfaga llegan fusionados en un solo turno, una línea por mensaje.
    const count = text.split('\n').filter((l) => l.trim()).length;
    return this.reply(STUB_REPLIES.default(count), 'respuesta-fija', { mensajes: count });
  }

  private reply(text: string, kind: string, extra: Record<string, unknown> = {}): LlmResponse {
    this.opts.log?.(`[STUB] ${kind}`, extra);
    return { text, toolCalls: [], stopReason: 'end', usage: this.usage() };
  }

  private usage() {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 0 };
  }
}
