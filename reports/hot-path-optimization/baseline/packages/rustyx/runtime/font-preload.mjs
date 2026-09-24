const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
export function fontPreloads(fonts = [], nonce) {
  return fonts.map(font => `<link rel="preload" as="font" href="${escape(font.href)}" type="${escape(font.type)}" crossorigin="anonymous"${nonce ? ` nonce="${escape(nonce)}"` : ''}>`).join('');
}
