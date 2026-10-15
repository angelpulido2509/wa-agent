/**
 * Diagnóstico de alcance de red a proveedores de LLM con plan gratis.
 * Hace UNA petición SIN API key al endpoint de modelos de cada proveedor y clasifica:
 *   ALCANZABLE: el servidor respondió (200, o 401/403 pidiendo autenticación) → la red llega a la API.
 *   BLOQUEADO:  rechazo de red/región (p. ej. Cloudflare "Access denied... network settings") o sin conexión.
 * No lee ni envía ninguna key.
 *
 *   npm run check:providers
 */

interface Target {
  name: string;
  url: string;
}

const TARGETS: Target[] = [
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/models' },
  { name: 'Cerebras', url: 'https://api.cerebras.ai/v1/models' },
  { name: 'Mistral', url: 'https://api.mistral.ai/v1/models' },
  { name: 'Google AI Studio (Gemini)', url: 'https://generativelanguage.googleapis.com/v1beta/models' },
  { name: 'GitHub Models', url: 'https://models.github.ai/catalog/models' },
  { name: 'NVIDIA NIM', url: 'https://integrate.api.nvidia.com/v1/models' },
  // Referencia: el bloqueo ya observado.
  { name: 'Groq (referencia)', url: 'https://api.groq.com/openai/v1/models' },
];

type Verdict = 'ALCANZABLE' | 'BLOQUEADO';

interface Result {
  name: string;
  status: number | null;
  server: string;
  verdict: Verdict;
  reason: string;
  ms: number;
}

/** Mensajes típicos de rechazo por red, país o región (Cloudflare, Google, etc.). */
const NETWORK_BLOCK =
  /access denied.*network|check your network settings|not available in your (country|region|location)|unsupported[_ ](country|region|location)|location is not supported|user location is not supported|region not supported|country.*(not supported|restricted)|error 10(06|07|08|20)|you have been blocked|sorry, you have been blocked|attention required/i;

/** Mensajes típicos de "falta la key" (la red llegó al servicio). */
const AUTH_MISSING =
  /api[ _-]?key|unauthori[sz]ed|authenticat|authorization|missing.*(key|token|credential)|invalid.*(key|token)|bearer|no auth|permission_denied|credentials/i;

function classify(status: number, body: string): { verdict: Verdict; reason: string } {
  if (NETWORK_BLOCK.test(body)) return { verdict: 'BLOQUEADO', reason: 'rechazo de red/región' };
  if (status >= 200 && status < 300) return { verdict: 'ALCANZABLE', reason: 'responde sin key (catálogo público)' };
  if ((status === 401 || status === 403) && AUTH_MISSING.test(body)) return { verdict: 'ALCANZABLE', reason: 'pide key (falta autenticación)' };
  if (status === 400 && AUTH_MISSING.test(body)) return { verdict: 'ALCANZABLE', reason: 'pide key (400 de autenticación)' };
  if (status === 403) return { verdict: 'BLOQUEADO', reason: '403 sin mensaje de autenticación' };
  if (status === 429) return { verdict: 'ALCANZABLE', reason: 'rate limit (la red llega)' };
  return { verdict: 'ALCANZABLE', reason: `HTTP ${status} del servicio (revisar cuerpo)` };
}

async function probe(t: Target): Promise<Result> {
  const t0 = Date.now();
  try {
    const res = await fetch(t.url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 2000);
    const { verdict, reason } = classify(res.status, body);
    return { name: t.name, status: res.status, server: res.headers.get('server') ?? '-', verdict, reason, ms: Date.now() - t0 };
  } catch (err) {
    const msg = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    return { name: t.name, status: null, server: '-', verdict: 'BLOQUEADO', reason: `sin conexión: ${msg.slice(0, 60)}`, ms: Date.now() - t0 };
  }
}

const results = await Promise.all(TARGETS.map(probe));
console.log('| Proveedor | HTTP | server | Clasificación | Motivo | ms |');
console.log('|---|---|---|---|---|---|');
for (const r of results) {
  console.log(`| ${r.name} | ${r.status ?? '—'} | ${r.server} | ${r.verdict === 'ALCANZABLE' ? '✅' : '⛔'} ${r.verdict} | ${r.reason} | ${r.ms} |`);
}
process.exit(0);
