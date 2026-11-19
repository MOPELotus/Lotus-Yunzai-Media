export function replyText(plugin, text) {
  return plugin.reply(text)
}

export async function replyImage(plugin, image, fallback) {
  if (!image || !await plugin.reply(globalThis.segment.image(image))) await replyText(plugin, fallback)
}
