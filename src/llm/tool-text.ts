/** Utilidades compartidas para tool calls de modelos que no siempre respetan el formato. */

/** Los argumentos pueden llegar como objeto o como string JSON. */
export function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

/**
 * Algunos modelos escriben la llamada a la tool como JSON en el texto en vez de usar tool_calls.
 * Si TODO el texto es una llamada a una tool conocida, se recupera como tool call (nunca se envía al cliente).
 */
export function recoverTextToolCall(text: string, toolNames: string[]): { name: string; input: unknown } | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, '')
    .replace(/^<tool_call>\s*|\s*<\/tool_call>$/g, '')
    .trim();
  if (!cleaned.startsWith('{') || !cleaned.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(cleaned) as { name?: unknown; arguments?: unknown; parameters?: unknown };
    if (typeof parsed.name !== 'string' || !toolNames.includes(parsed.name)) return null;
    return { name: parsed.name, input: parseArguments(parsed.arguments ?? parsed.parameters) };
  } catch {
    return null;
  }
}
