(() => {
  'use strict';
  const { summary } = JSON.parse(document.getElementById('benchmark-data').textContent);
  const fields = {
    cpuMsPerRequest: { unit: 'ms', digits: 4, direction: 'Temps CPU par réponse valide · Plus bas = moins de CPU.', lower: true, less: 'de CPU en moins par réponse.', more: 'de CPU en plus par réponse.' },
    loadMedianRssMiB: { unit: 'Mio', digits: 1, direction: 'RSS médian de tous les processus serveur · Plus bas = moins de RAM.', lower: true, less: 'de RAM médiane en moins.', more: 'de RAM médiane en plus.' },
    sampledPeakRssMiB: { unit: 'Mio', digits: 1, direction: 'Pic RSS échantillonné · Plus bas = moins de RAM au pic observé.', lower: true, less: 'de RAM en moins au pic observé.', more: 'de RAM en plus au pic observé.' },
    requestsPerSecond: { unit: 'rép./s', digits: 0, direction: 'Réponses valides par seconde · Plus haut = plus de débit.', lower: false, less: 'de réponses par seconde en moins.', more: 'de réponses par seconde en plus.' },
    p95Ms: { unit: 'ms', digits: 2, direction: '95 % des réponses arrivent dans ce délai · Plus bas = moins d’attente.', lower: true, less: 'de latence P95 en moins.', more: 'de latence P95 en plus.' },
    cpuPercentOneCore: { unit: '% d’un cœur', digits: 1, direction: 'CPU total à saturation · À interpréter avec le débit atteint.', lower: true, less: 'de CPU total en moins à saturation.', more: 'de CPU total en plus à saturation.' },
  };
  const names = { next: 'Next.js', rustyx: 'Rustyx', before: 'Rustyx avant optimisation' };
  const symbols = { next: 'N', rustyx: 'R', before: 'R' };
  const select = document.getElementById('scenario');
  const before = document.getElementById('show-before');
  const chart = document.getElementById('chart');
  const insight = document.getElementById('insight');
  let metric = 'cpuMsPerRequest';
  const format = (value, digits = 0) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function draw() {
    const item = summary[Number(select.value)];
    const field = fields[metric];
    const engines = before.checked ? ['next', 'rustyx', 'before'] : ['next', 'rustyx'];
    const maximum = Math.max(...engines.map(engine => item.engines[engine].ranges[metric][1])) * 1.08 || 1;
    const fragment = document.createDocumentFragment();
    for (const engine of engines) {
      const value = item.engines[engine][metric];
      const [low, high] = item.engines[engine].ranges[metric];
      const row = element('div', 'bar-row ' + engine);
      row.dataset.engine = engine;
      const header = element('div', 'bar-heading');
      const label = element('span', 'engine');
      const symbol = element('span', 'engine-symbol', symbols[engine]);
      symbol.setAttribute('aria-hidden', 'true');
      label.append(symbol, document.createTextNode(names[engine]));
      const amount = element('span', 'bar-value', format(value, field.digits) + ' ');
      amount.dataset.value = String(value);
      amount.append(element('small', '', field.unit));
      header.append(label, amount);
      const track = element('div', 'bar-track');
      track.setAttribute('role', 'img');
      track.setAttribute('aria-label', `${names[engine]} : ${format(value, field.digits)} ${field.unit}. Minimum ${format(low, field.digits)}, maximum ${format(high, field.digits)}.`);
      const fill = element('div', 'bar-fill');
      fill.style.width = `${value / maximum * 100}%`;
      const range = element('span', 'bar-range');
      range.style.left = `${low / maximum * 100}%`;
      range.style.width = `${(high - low) / maximum * 100}%`;
      track.append(fill, range);
      row.append(header, track);
      fragment.append(row);
    }
    const axis = element('div', 'chart-axis');
    axis.append(element('span', '', '0'), element('span', '', `${format(maximum, field.digits)} ${field.unit}`));
    fragment.append(axis);
    chart.replaceChildren(fragment);
    document.getElementById('direction').textContent = field.direction;
    document.querySelectorAll('[data-key]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.key === metric)));
    document.querySelectorAll('[data-shortcut]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.shortcut === select.value)));

    const delta = item.versusNext[metric];
    const r = item.engines.rustyx.ranges[metric];
    const n = item.engines.next.ranges[metric];
    const overlap = r[0] <= n[1] && n[0] <= r[1];
    const better = field.lower ? delta < 0 : delta > 0;
    const number = document.getElementById('insight-number');
    if (metric === 'requestsPerSecond') {
      number.replaceChildren(document.createTextNode(format(item.engines.rustyx[metric] / item.engines.next[metric], 2)), element('small', '', '×'));
      document.getElementById('insight-label').textContent = 'le débit de Next.js sur cette charge.';
    } else {
      number.replaceChildren(document.createTextNode(format(Math.abs(delta), 1)), element('small', '', '%'));
      document.getElementById('insight-label').textContent = delta <= 0 ? field.less : field.more;
    }
    document.getElementById('insight-context').textContent = `Rustyx face à Next.js. ${item.label}.`;
    const caution = overlap || Math.abs(delta) < 5 || !better || metric === 'cpuPercentOneCore';
    insight.dataset.caution = String(caution);
    const notes = [];
    if (metric === 'cpuPercentOneCore') notes.push('Le CPU total dépend aussi du débit. Consultez « CPU / réponse » pour comparer le coût du travail fourni.');
    else if (overlap) notes.push('Écart à confirmer : les plages des trois passages se recouvrent.');
    else if (Math.abs(delta) < 5) notes.push('Petit écart : une répétition sur la machine cible est nécessaire pour conclure.');
    else notes.push('Médiane de trois essais. Les conditions et la charge influencent les résultats.');
    if ((item.scenario === 'isr-hit' || item.scenario === 'image-hot') && ['loadMedianRssMiB', 'sampledPeakRssMiB'].includes(metric)) notes.push('Hits natifs seuls : Node n’a pas démarré. Ce RSS ne représente pas un site après rendu React.');
    if (before.checked) {
      const change = item.versusBefore[metric];
      notes.push(`Face à l’ancien Rustyx : ${change < 0 ? '−' : '+'}${format(Math.abs(change), 1)} % sur cette mesure.`);
    }
    document.getElementById('insight-confidence').textContent = notes.join(' ');
  }
  function choose(index, key) {
    if (Number.isInteger(index) && summary[index]) select.value = String(index);
    if (key && Object.hasOwn(fields, key)) metric = key;
    draw();
  }
  select.addEventListener('change', draw);
  before.addEventListener('change', draw);
  document.querySelectorAll('[data-key]').forEach(button => button.addEventListener('click', () => choose(Number(select.value), button.dataset.key)));
  document.querySelectorAll('[data-shortcut]').forEach(button => button.addEventListener('click', () => choose(Number(button.dataset.shortcut))));
  document.querySelectorAll('[data-case]').forEach(link => link.addEventListener('click', () => choose(Number(link.dataset.case), link.dataset.metric)));
  draw();
  document.documentElement.classList.add('js');
})();
