"""Render the standalone marketing page from the validated benchmark data."""
import html
import json
from pathlib import Path


def number(value, digits=0):
    return f'{value:,.{digits}f}'.replace(',', '\u202f').replace('.', ',')


def render_page(summary, report, validation, sustained=None, flight=None):
    templates = Path(__file__).resolve().parent / 'templates'
    page = (templates / 'hot-path-performance.html').read_text()
    by_case = {(item['site'], item['scenario']): item for item in summary}
    isr = by_case['documentation', 'isr-hit']
    images = by_case['boutique', 'image-hot']
    api = by_case['journal', 'api-pages']
    asynchronous = by_case['portail', 'async-512']

    def ratio(item):
        return item['engines']['rustyx']['requestsPerSecond'] / item['engines']['next']['requestsPerSecond']

    def bars(item):
        metric = 'cpuMsPerRequest'
        maximum = max(item['engines'][engine]['ranges'][metric][1] for engine in ['next', 'rustyx']) * 1.08
        result = []
        for engine, label, letter in [('next', 'Next.js', 'N'), ('rustyx', 'Rustyx', 'R')]:
            values = item['engines'][engine]
            low, high = values['ranges'][metric]
            result.append(f'''<div class="bar-row {engine}" data-engine="{engine}">
              <div class="bar-heading"><span class="engine"><span class="engine-symbol" aria-hidden="true">{letter}</span>{label}</span><span class="bar-value">{number(values[metric], 4)} <small>ms</small></span></div>
              <div class="bar-track" role="img" aria-label="{label} : {number(values[metric], 4)} millisecondes par réponse ; de {number(low, 4)} à {number(high, 4)} selon le passage">
                <div class="bar-fill" style="width:{values[metric]/maximum*100:.4f}%"></div>
                <span class="bar-range" style="left:{low/maximum*100:.4f}%;width:{(high-low)/maximum*100:.4f}%"></span>
              </div></div>''')
        result.append(f'<div class="chart-axis"><span>0</span><span>{number(maximum, 4)} ms</span></div>')
        return ''.join(result)

    rows = []
    for i, item in enumerate(summary):
        n, r = item['engines']['next'], item['engines']['rustyx']
        cpu_delta = item['versusNext']['cpuMsPerRequest']
        cpu_label = ('−' if cpu_delta < 0 else '+') + number(abs(cpu_delta), 1)
        rows.append(f'''<tr><th scope="row"><a href="#comparaison" data-case="{i}">{html.escape(item['label'])}<span aria-hidden="true">↗</span></a></th>
          <td><span class="{'table-gain' if cpu_delta < 0 else 'orange'}">{cpu_label} %</span><small>{number(n['cpuMsPerRequest'], 4)} → {number(r['cpuMsPerRequest'], 4)} ms</small></td>
          <td>{number(r['loadMedianRssMiB'], 1)} <span class="muted">/ {number(n['loadMedianRssMiB'], 1)}</span></td>
          <td>{number(ratio(item), 2)}×</td></tr>''')

    def endurance(data, title, description, source):
        if not data:
            return ''
        engines = {row['engine']: row for row in data['results']}
        r, n = engines['rustyx'], engines['next']
        throughput = r['requestsPerSecond'] / n['requestsPerSecond']
        cpu = 100 * (1 - r['cpuMsPerRequest'] / n['cpuMsPerRequest'])
        ram = 100 * (1 - r['loadMedianRssMiB'] / n['loadMedianRssMiB'])
        return f'''<article class="endurance-card"><div class="endurance-caption"><span class="live-dot" aria-hidden="true"></span>{html.escape(description)}</div>
          <h3>{html.escape(title)}</h3><div class="endurance-number">{number(throughput, 2)}<span>×</span></div><p class="endurance-label">le débit de Next.js</p>
          <div class="mini-compare"><div><span>Next.js</span><strong>{number(n['requestsPerSecond'])}</strong><i style="--bar:{100/throughput:.3f}%"></i></div><div><span>Rustyx</span><strong>{number(r['requestsPerSecond'])}</strong><i style="--bar:100%"></i></div></div>
          <p class="mini-unit">Réponses par seconde · même charge</p>
          <div class="endurance-foot"><span><strong>−{number(cpu, 1)} %</strong> CPU / réponse</span><span><strong>−{number(ram, 1)} %</strong> RAM médiane</span></div>
          <a class="text-link light" href="{source}">Consulter cette mesure <span aria-hidden="true">↗</span></a></article>'''

    payload = {
        'summary': summary,
        'machine': report['machine'],
        'stats': {key: validation[key] for key in ['trials', 'responses', 'errors', 'functionalPairs']},
    }
    replacements = {
        '__CSS__': (templates / 'hot-path-performance.css').read_text(),
        '__JAVASCRIPT__': (templates / 'hot-path-performance.js').read_text(),
        '__PAYLOAD__': json.dumps(payload, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c'),
        '__RESPONSES__': number(validation['responses']),
        '__RESPONSES_MILLIONS__': number(validation['responses'] / 1_000_000, 2),
        '__TRIALS__': str(validation['trials']),
        '__PAIRS__': str(validation['functionalPairs']),
        '__NEXT_VERSION__': html.escape(report['machine']['next']),
        '__NODE_VERSION__': html.escape(report['machine']['node']),
        '__HERO_RATIO__': number(ratio(isr), 2),
        '__HERO_NEXT_RPS__': number(isr['engines']['next']['requestsPerSecond']),
        '__HERO_RUSTYX_RPS__': number(isr['engines']['rustyx']['requestsPerSecond']),
        '__HERO_NEXT_WIDTH__': f'{100/ratio(isr):.4f}',
        '__IMAGES_CPU__': number(-images['versusNext']['cpuMsPerRequest']),
        '__API_RAM__': number(-api['versusNext']['loadMedianRssMiB']),
        '__API_RUSTYX_RAM__': number(api['engines']['rustyx']['loadMedianRssMiB']),
        '__API_NEXT_RAM__': number(api['engines']['next']['loadMedianRssMiB']),
        '__ASYNC_RATIO__': number(ratio(asynchronous), 2),
        '__ISR_CPU__': number(-isr['versusNext']['cpuMsPerRequest'], 1),
        '__INITIAL_BARS__': bars(isr),
        '__INITIAL_MAX__': number(max(isr['engines'][e]['ranges']['cpuMsPerRequest'][1] for e in ['next', 'rustyx']) * 1.08, 4),
        '__OPTIONS__': ''.join(f'<option value="{i}">{html.escape(item["label"])}</option>' for i, item in enumerate(summary)),
        '__TABLE_ROWS__': ''.join(rows),
        '__ENDURANCE_CARDS__': endurance(sustained, 'Le PPR en conditions de charge.', '60 secondes · 64 clients', 'sustained.json') + endurance(flight, 'Le Flight, sur la durée.', '30 secondes · 4 clients', 'flight-sustained.json'),
    }
    for key, value in replacements.items():
        page = page.replace(key, value)
    return page
