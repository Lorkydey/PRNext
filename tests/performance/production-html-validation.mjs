const counts = new Map([['/ssr', 100], ['/heavy', 1000], ['/legacy', 100], ['/guarded', 100], ['/static', 100]]);
const expected = new Map([100, 1000].map(count => [count, '<table><tbody>' + Array.from({ length: count }, (_, index) => `<tr><td>${index}</td><td>row ${index}</td><td>${index * 7}</td></tr>`).join('') + '</tbody></table>']));
const pathname = route => String(route).split('?')[0];

export function fixtureTableRowCount(route) { return counts.get(pathname(route)); }

/** Validate the actual HTML table, rather than a heading or serialized Flight copy. */
export function hasFixtureTable(body, route) {
  const count = fixtureTableRowCount(route);
  if (!count) return true;
  const html = body.toString('utf8').replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[^>]*>[\s\S]*$/gi, '');
  return html.includes(expected.get(count));
}
