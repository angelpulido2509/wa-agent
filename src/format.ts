/**
 * Red de seguridad determinística: convierte el Markdown que a veces escriben los modelos
 * al formato de WhatsApp. No cambia el contenido, solo la sintaxis.
 */
export function toWhatsAppFormat(text: string): string {
  const out = text
    .replace(/\*\*\*(.+?)\*\*\*/g, '*_$1_*') // ***negrita cursiva***
    .replace(/\*\*(.+?)\*\*/g, '*$1*') // **negrita** → *negrita*
    .replace(/__(.+?)__/g, '_$1_') // __cursiva__ → _cursiva_
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*') // # Título → *Título*
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)') // [texto](url) → texto (url)
    .replace(/[ \t]+$/gm, '') // espacios al final de línea
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return dropDanglingMarker(dropDanglingMarker(out, '_'), '*');
}

/** Un "_" o "*" sin pareja al final se ve como basura en WhatsApp ("¿…?_"): se quita. */
function dropDanglingMarker(text: string, marker: '_' | '*'): string {
  const count = text.split(marker).length - 1;
  return count % 2 === 1 && text.endsWith(marker) ? text.slice(0, -1).trimEnd() : text;
}
