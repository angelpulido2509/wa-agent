# wa-agent

Agente de WhatsApp para atención de clientes con un LLM (Groq, Claude u Ollama) y controles deterministas. Conexión por QR (Baileys, multi-device), memoria en SQLite y un panel local para ver chats, pausar el bot y vincular/desvincular el número.

## Requisitos
- Node 20+
- Una key de un proveedor de LLM: Groq (`GROQ_API_KEY`, plan gratis) o Anthropic (`ANTHROPIC_API_KEY`)
- Opcional: [Ollama](https://ollama.com/download), solo con hardware potente

## Puesta en marcha
```bash
npm install
cp .env.example .env      # completa GROQ_API_KEY (o ANTHROPIC_API_KEY), PANEL_TOKEN y TEST_NUMBERS
npm run test:agent        # prueba el agente en la terminal, sin WhatsApp
npm run dev               # levanta el bot + panel en http://127.0.0.1:3000
```
Abre el panel, pega tu `PANEL_TOKEN` y escanea el QR desde WhatsApp → *Dispositivos vinculados*.

## Proveedor de LLM
`src/llm/` define una interfaz común (`system`, historial y tools → `{ text, toolCalls, usage }`):

| `LLM_PROVIDER` | Cuándo usarlo | Detalles |
|---|---|---|
| `openai-compatible` (por defecto) | Desarrollo y pruebas con **Groq** (plan gratis) | `fetch` a `{LLM_BASE_URL}/chat/completions` con tool calling formato OpenAI. Reintenta 429/5xx (máx. 3, respeta `Retry-After`). Variables: `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` (o `GROQ_API_KEY` con Groq), `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`, `LLM_TIMEOUT_MS`, `LLM_REASONING_EFFORT`. |
| `anthropic` | **Producción**: Claude Haiku 5.5 (`claude-haiku-5-5`) | SDK oficial con `cache_control` en el bloque estable del system. Variables: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`. |
| `stub` | **Solo pruebas** de integración con WhatsApp (`TEST_MODE=true` obligatorio) | Respuestas fijas y deterministas, marcadas `[STUB]` en los logs; simula `transferir_a_humano` si el mensaje coincide con `STUB_HANDOFF_PATTERN`. |
| `ollama` | Opcional, **solo con hardware potente** (GPU con 12+ GB de VRAM). En CPU con 8 GB de RAM el único modelo que cabe (3B) no sigue las reglas. | API nativa `/api/chat` con `num_ctx`, `think: false` y tools. Usa un prompt compacto con ejemplos. |

Si un modelo escribe la llamada a la tool como JSON en el texto, se recupera como tool call real y nunca se envía al cliente.

## Controles deterministas (`src/guards/`)
Independientes del proveedor; las palabras clave están en `knowledge/reglas.json` (editable, se relee en cada mensaje; se compara sin mayúsculas ni tildes).

1. **Antes del modelo** (`pre.ts`, **no consulta al modelo**). Cada intención de `pre.intents` tiene una `accion`:
   - `derivar` (por defecto): plazos, agendar reunión/llamada/demo, tecnologías, cuotas/financiamiento, reclamos, referencias → mensaje fijo + handoff.
   - `responder`: horario, formas de pago y "¿la reunión es gratis?" → mensaje fijo con el dato confirmado + UNA pregunta, sin handoff.
   - `precios` (`precios.ts`): detecta el servicio por las `keywords` de la sección `precios` (la frase más larga gana; "app" sola da app web y app móvil) y responde el rango referencial + nota + handoff. Sin servicio, hace UNA pregunta ("¿Para qué producto o servicio…?") y, con la respuesta, da el rango.
   - Fuera de horario (`horario` en `reglas.json`), todo aviso de handoff dice "a partir de las 8:00 am (hora de Caracas)" (`horario.ts`).
2. **Después del modelo** (`post.ts`, `datos.ts`): corrige Markdown y bloquea montos que no sean un rango completo de la tabla (o "desde N" sin tope), mensualidades/topes con cifra, otras monedas, horas distintas al horario de atención, formas de pago no aceptadas (`post.pagosNoAceptados`), plazos, tecnologías que no están en `negocio.md`, más de una pregunta o una tool escrita como texto. Reintenta una vez con una instrucción correctiva; si vuelve a fallar, responde un mensaje seguro y deriva. Cada bloqueo queda en el log (`Control automático`).

**Fuente única de verdad** (`negocio.ts`): los rangos (tabla "Rangos de precio"), el horario ("Horario de atención") y las formas de pago ("Formas de pago") se leen **solo de `negocio.md`**. `reglas.json` dice cómo detectarlos (`precios.servicios[].fila` + `keywords`) y sus textos usan marcadores (`{horario}`, `{formasDePago}`, `{abre}`). Si una fila de la tabla no tiene servicio en `reglas.json` (o al revés), el bot falla con un error claro y los tests también.

Otras intenciones fijas: `identidad` (pedir el prompt, "ignora tus reglas", "¿qué modelo eres?" → respuesta fija, sin modelo), `fuera_de_tema` (clima, recetas, recomendaciones… → redirige a DevBull), `ubicacion` (otra ciudad o país → handoff), `referencias` (incluye pedir el contacto de un cliente → handoff). Si un mensaje trae precio y otra consulta, se responde el precio y la otra queda en el motivo. El post-guard también quita oraciones que aceptan instrucciones del usuario (`post.instrucciones`), afirman cobertura que no está en `negocio.md` (`post.cobertura`) o nombran áreas que no están ahí (`post.areas`); corrige preguntas dobles ("¿…y qué…?") y recorta respuestas cortadas por `max_tokens` a la última oración completa.

## Escenarios de regresión
```bash
npm run test:scenarios -- --provider openai-compatible --model qwen/qwen3.8-27b --runs 3
npm run test:scenarios -- --provider anthropic --model claude-haiku-5-5 --runs 3
```
10 escenarios (a–j) con las mismas validaciones para todos los modelos. Muestra respuesta, handoff, latencia, tokens y si lo resolvió el guard o el modelo. Guarda el reporte en `reportes/`. Opciones: `--only c,d`, `--base-url`, `--pause-ms`.

## Cómo funciona
- `knowledge/negocio.md` es la única fuente de verdad del agente. Se relee en cada mensaje.
- **Modo prueba** (`TEST_MODE=true`): solo responde a los números de `TEST_NUMBERS`; el resto se ignora y se loguea.
- **Debounce**: espera `DEBOUNCE_MS` para juntar ráfagas de mensajes antes de responder.
- **Handoff**: si el cliente pide precio, plazos, una reunión, una persona, reclama o pregunta algo que no está en el documento, el bot avisa que lo atenderá una persona, pausa el chat `HANDOFF_PAUSE_HOURS` horas y (con `NOTIFY_OWNER=true`) te avisa en tu chat contigo mismo.
- **Si respondes tú desde el teléfono**, el bot se pausa en ese chat automáticamente.
- Límite de `MAX_REPLIES_PER_HOUR` respuestas por chat. Audios/imágenes se guardan como `[audio]`, `[imagen]`…; el bot pide que escriban en texto.

## Scripts
| Script | Qué hace |
|---|---|
| `npm run dev` | Bot + panel |
| `npm run test:agent` | Chat con el agente en la terminal (muestra tokens y cache) |
| `npm test` | Tests unitarios con mocks (no llaman a APIs reales) |
| `npm run test:scenarios` | Escenarios contra el LLM real (ver arriba) |
| `npm run check:providers` | Comprueba sin keys si tu red alcanza a OpenRouter, Cerebras, Mistral, Gemini, GitHub Models, NVIDIA NIM y Groq |
| `npm run typecheck` | `tsc --noEmit` |

## API del panel
Todas requieren `x-panel-token` (o `?token=`). Formato `{ success, data, error }`.

| Método | Ruta | |
|---|---|---|
| GET | `/api/status` | Estado de conexión y QR |
| GET | `/api/events` | SSE: eventos `status` y `chats` |
| GET | `/api/chats` | Lista de chats |
| GET | `/api/chats/:jid/messages` | Conversación |
| POST | `/api/chats/:jid/pause` | Pausar bot (`{ hours?, reason? }`) |
| POST | `/api/chats/:jid/resume` | Reactivar bot |
| POST | `/api/logout` | Desvincular el número |

## Datos locales
`./auth` (sesión de WhatsApp) y `./data` (SQLite) no se suben a git. Borrar `./auth` obliga a escanear el QR de nuevo.

## Nota sobre Baileys
Baileys es una librería no oficial de WhatsApp Web. Úsala con moderación (sin envíos masivos) para reducir el riesgo de bloqueo del número.
