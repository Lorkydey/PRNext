/** Reject executable markup instead of silently stripping author content or
 * React reveal instructions. HTML-only documents must already be complete. */
export function assertHtmlOnlyDocument(html, pattern = '') {
  const fail = reason => { throw new Error(`htmlOnly route ${pattern} emitted ${reason}. Use static HTML elements without JavaScript.`); };
  if (typeof html !== 'string') fail('an invalid HTML document');
  if (/<\s*(?:script|iframe|object|embed)(?=[\s/>])/i.test(html)) fail('a script or embedded browsing context');
  const tags = /<[a-z][^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/gi;
  const attributes = /([^\s/>=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const decode = value => value.replace(/&#(?:x([\da-f]+)|(\d+));?/gi, (_, hex, decimal) => String.fromCodePoint(Math.min(0x10ffff, parseInt(hex || decimal, hex ? 16 : 10)))).replace(/&(?:colon|tab|newline);/gi, entity => ({'&colon;':':','&tab;':'\t','&newline;':'\n'})[entity.toLowerCase()]);
  for (const match of html.matchAll(tags)) {
    const tag = match[0], start = /^<[\w:-]+/.exec(tag)[0].length;
    const values = new Map();
    for (const attribute of tag.slice(start).matchAll(attributes)) {
      const name = attribute[1].toLowerCase(), value = decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
      // HTML ignores later duplicate attributes; preserve the same first value
      // when interpreting link token lists and resource destinations.
      if (!values.has(name)) values.set(name,value);
      if (/^on[a-z]/.test(name) || name === 'srcdoc') fail(`interactive attribute ${name}`);
      if (name === 'name' && value.startsWith('$ACTION_')) fail('a Server Action form');
      if (['href','src','action','formaction','xlink:href'].includes(name)) {
        if (/^javascript:/i.test(value.replace(/[\u0000-\u0020]/g, ''))) fail('a JavaScript URL');
      }
    }
    if (/^<link\b/i.test(tag) && ((values.get('rel') || '').toLowerCase().split(/[\t\n\f\r ]+/).includes('modulepreload') || (values.get('as') || '').trim().toLowerCase() === 'script')) fail('a JavaScript preload');
  }
  return html;
}
