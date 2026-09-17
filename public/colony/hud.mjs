/* Die Leiste oben: Zaehler, ihre Hover-Cards, Planetenwahl, Uhr-Stempel. */

/* Nur die eine Komponente, nicht das Sammelbundle: Shoelaces dist/ importiert
 * in sich selbst relativ, ein einzelnes Modul zieht also alles Noetige nach.
 * Die Importmap in index.html loest den blanken Namen auf. */
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';

import { escapeHtml, familyDot } from './html.mjs';
import { locale, t } from './i18n.mjs';
import { index, reorderWouldMove, rootOf } from './hexmap.mjs';
import { fitView, mode, scheduleTick, setMode } from './renderer.mjs';
import { app, planet } from './store.mjs';

/* Die HUD-Zaehler.
 *
 * Die Texte stehen nicht hier, sondern in den Sprachdateien
 * (`public/i18n/<code>.json`) unter `hud.counts.<key>`: `label` an der Zahl,
 * dazu die Hover-Card aus `title`, `hint` und - wo es eine Aufschluesselung
 * gibt - `rows` als Einheitenzeile und `empty` fuer die leere Liste. Der
 * `key` des Zaehlers ist damit gleichzeitig der Schluessel seiner
 * Beschriftung; eine zweite Liste, die beides verbindet, gibt es nicht.
 *
 * Die Erklaersaetze nennen die echten Schwellwerte aus
 * `config/colony.config.json` - wer sie dort aendert, muss sie in allen
 * Sprachdateien nachziehen; ein zweiter Weg, sie zur Laufzeit einzublenden,
 * waere mehr Apparat als die Sache wert.
 *
 * Hier bleibt, was Verhalten ist: `pick` filtert die Agenten aller Planeten,
 * `rows` ist der Ausweg fuer Zaehler, die keine Agenten zaehlen (Sessions,
 * Hangar), `planets` zaehlt je Planet, `tone` faerbt die Zahl. */
const HUD_GROUPS = [
  [
    { key: 'projects', tip: { planets: (p) => p.hexes.length } },
    { key: 'satellites', tip: { planets: (p) => p.hexes.filter((h) => h.parentId).length } },
    {
      key: 'dirty',
      tone: 'alert',
      tip: { ring: 'dirty', rows: (h) => (h.gitState === 'dirty' ? h.dirty : null) },
    },
    {
      key: 'unpushed',
      tip: {
        ring: 'unpushed',
        rows: (h) =>
          h.gitState === 'unpushed'
            ? // Ohne Upstream ist `ahead` nicht ermittelbar. Dann steht hier ein
              // Strich, keine geratene Zahl — das Feld zaehlt trotzdem mit,
              // weil es Commits gab (siehe git.mjs).
              { sort: h.ahead ?? 0, text: h.ahead === null ? '—' : String(h.ahead) }
            : null,
      },
    },
  ],
  [
    { key: 'agents', tip: { pick: () => true } },
    { key: 'open', tip: { pick: (a) => a.open === true && !a.sub } },
    { key: 'working', tone: 'ok', tip: { dot: 'working', pick: (a) => a.state === 'working' } },
    { key: 'prompt', tone: 'alert', tip: { dot: 'prompt', pick: (a) => a.state === 'prompt' } },
    { key: 'waiting', tone: 'warn', tip: { dot: 'waiting', pick: (a) => a.state === 'waiting' } },
    { key: 'sessions', tip: { rows: (h) => h.sessions.total } },
    { key: 'unassigned', hideWhenZero: true, tip: { station: true } },
  ],
];

/* Ein Text, der in der Sprachdatei fehlen darf: `t()` gibt bei einem
 * unbekannten Schluessel den Schluessel zurueck, und das ist hier die
 * Antwort "gibt es nicht" statt einer Beschriftung. */
const or = (key, fallback) => (t(key) === key ? fallback : t(key));

const ROWS_MAX = 6;

/* Eine Zeile ist `{ sort, text }`: sortiert wird nach der Zahl, angezeigt der
 * Text. Auseinander gehen die beiden nur da, wo der Wert nicht ermittelbar ist
 * — `ahead` ohne Upstream steht als Strich in der Karte, sortiert sich aber
 * mit. Eine blanke Zahl aus `rows` ist die Abkuerzung fuer beides. */
const asRow = (v) =>
  v === null || v === undefined
    ? null
    : typeof v === 'object'
      ? v
      : v > 0
        ? { sort: v, text: String(v) }
        : null;

/** Aufschluesselung nach Projekt, ueber alle Planeten. Absteigend, gedeckelt. */
function tipRows(tip) {
  const rows = [];
  for (const p of app.state.planets) {
    if (tip.planets) {
      const row = asRow(tip.planets(p));
      if (row) rows.push({ label: p.label, ...row });
      continue;
    }
    if (tip.station) {
      for (const a of p.station.agents) {
        rows.push({ label: a.name ?? a.agentType ?? t('hud.session'), sort: 1, text: '1' });
      }
      continue;
    }
    const idx = index(p.hexes);
    for (const h of p.hexes) {
      const row = asRow(tip.rows ? tip.rows(h) : h.agents.filter(tip.pick).length);
      if (!row) continue;
      // Satelliten und ihre Wurzel tragen denselben Punkt; der volle relative
      // Pfad haengt als title dran, damit "development" nicht allein steht.
      const root = rootOf(h, idx);
      const inFamily = root !== h || h.satellites > 0;
      rows.push({
        label: h.title,
        dot: inFamily ? familyDot(root.path) : '',
        title: root !== h ? root.title + '/' + h.title : '',
        ...row,
      });
    }
  }
  rows.sort((a, b) => b.sort - a.sort || a.label.localeCompare(b.label));
  const shown = rows.slice(0, ROWS_MAX);
  const restN = rows.slice(ROWS_MAX).reduce((n, r) => n + r.sort, 0);
  return { shown, rest: rows.length - shown.length, restN };
}

/** Der Hover-Card-Inhalt. Leere Aufschluesselung wird benannt, nicht verschwiegen. */
function tipContent(item, value) {
  const { tip } = item;
  const base = 'hud.counts.' + item.key + '.';
  const rowsLabel = or(base + 'rows', null);
  const { shown, rest, restN } = tipRows(tip);
  const body = shown.length
    ? (rowsLabel ? '<li class="unit"><span>' + escapeHtml(rowsLabel) + '</span></li>' : '') +
      shown
        .map(
          (r) =>
            '<li' + (r.title ? ' title="' + escapeHtml(r.title) + '"' : '') + '><span>' +
            (r.dot ?? '') + escapeHtml(r.label) + '</span><b>' + r.text + '</b></li>',
        )
        .join('') +
      (rest
        ? '<li class="more"><span>' + escapeHtml(t('hud.more', { n: rest })) +
          '</span><b>' + restN + '</b></li>'
        : '')
    : '<li class="empty"><span>' +
      escapeHtml(or(base + 'empty', t('hud.empty'))) + '</span></li>';
  return (
    '<div class="tip-head">' +
    (tip.dot ? '<i class="dot ' + tip.dot + '"></i>' : '') +
    (tip.ring ? '<i class="ring ' + tip.ring + '"></i>' : '') +
    '<span>' + escapeHtml(t(base + 'title')) + '</span><b>' + value + '</b></div>' +
    '<p>' + escapeHtml(t(base + 'hint')) + '</p>' +
    '<ul>' + body + '</ul>'
  );
}

/* Die Zaehler werden einmal gebaut und danach nur noch beschrieben. Ein
 * innerHTML pro Poll wuerde einen offenen Tooltip alle fuenf Sekunden unter
 * dem Mauszeiger wegreissen. */
let hudCells = null;

function buildHudCells() {
  hudCells = new Map();
  // Einmal verdrahtet, wie die Zaehler: der Knopf lebt im HTML, sein
  // Verhalten haengt am Callback in colony.js (kein Import von dort — hud.mjs
  // wird von colony.js importiert, das waere ein Zyklus).
  document.getElementById('reorder').onclick = () => app.reorder?.();
  // der Skin-Wechsel in r3d ruft ihn, damit aria-pressed nicht auf den
  // naechsten Poll wartet — hud.mjs darf r3d nicht importieren, r3d darf
  // hud.mjs nicht importieren.
  app.refreshHud = renderHud;
  document.getElementById('mode3d').onclick = async () => {
    await setMode(mode() === '3d' ? '2d' : '3d');
    renderHud(); // aria-pressed nachziehen
  };
  // Skin nur in 3D: der Handler existiert, solange r3d gemountet ist (index.mjs)
  document.getElementById('modekit').onclick = async () => {
    await app.setSkin?.(app.skin?.() === 'kit' ? 'clean' : 'kit');
    renderHud();
  };
  const counts = document.getElementById('counts');
  counts.textContent = '';
  for (const group of HUD_GROUPS) {
    const g = document.createElement('span');
    g.className = 'grp';
    for (const item of group) {
      const cell = document.createElement('span');
      cell.className = 'cnt';
      const value = document.createElement('b');
      const trigger = document.createElement('span');
      trigger.className = 'trg';
      trigger.append(value, ' ' + t('hud.counts.' + item.key + '.label'));

      let content = null;
      if (item.tip) {
        const tip = document.createElement('sl-tooltip');
        // hoist: der Tooltip haengt sonst im HUD-Stacking-Kontext und liegt
        // unter dem Panel. placement/distance sind Geschmack, nicht noetig.
        tip.setAttribute('hoist', '');
        tip.setAttribute('placement', 'bottom-start');
        // 18 statt der ueblichen 8-10: der Pfeil sitzt auf der Oberkante der
        // Karte und lag darunter zur Haelfte hinter der HUD-Leiste — dunkel
        // auf dunkel, also unsichtbar. Erst ab hier steht er frei auf dem Feld.
        tip.setAttribute('distance', '18');
        content = document.createElement('div');
        content.slot = 'content';
        content.className = 'tip';
        tip.append(content, trigger);
        cell.append(tip);
      } else {
        cell.append(trigger);
      }
      g.append(cell);
      hudCells.set(item.key, { item, cell, value, content });
    }
    counts.append(g);
  }
}

function renderHud() {
  const c = app.state.counts;
  // Zwei Gruppen wie in der Legende: was ueber die Felder gilt (Projekte,
  // Git-Zustand) und was ueber die Figuren (Agenten, Sessions, Hangar).
  if (!hudCells) buildHudCells();
  for (const { item, cell, value, content } of hudCells.values()) {
    const n = c[item.key];
    cell.hidden = item.hideWhenZero && !n;
    value.textContent = n;
    value.className = n && item.tone ? item.tone : '';
    if (content) content.innerHTML = tipContent(item, n);
  }
  /* Der Knopf sagt an, ob es etwas zu ordnen gibt. Meist gibt es das nicht:
   * nach dem ersten Druck liegt die Karte im Gewichts-Optimum, und der
   * Auto-Umordner haelt sie dort. Gedimmt heisst "nichts zu tun", nicht
   * "kaputt" — deaktiviert wird er nicht, ein Druck darf immer erlaubt
   * sein. Der Trockenlauf kostet ein Layout ueber gut zwanzig Felder. */
  const reorderBtn = document.getElementById('reorder');
  const leer = !reorderWouldMove(planet()?.hexes ?? [], app.collapsed);
  reorderBtn.classList.toggle('leer', leer);
  reorderBtn.title = leer ? t('hud.reorderIdle') : t('hud.reorderTitle');

  document.getElementById('mode3d').setAttribute('aria-pressed', String(mode() === '3d'));
  const kitBtn = document.getElementById('modekit');
  kitBtn.hidden = mode() !== '3d';
  kitBtn.setAttribute('aria-pressed', String(app.skin?.() === 'kit'));
  // Der Poll-Zeitpunkt ist der Fetch hier im Browser; der Server cached seinen
  // Zustand einige Sekunden, `generatedAt` kann also aelter sein. Beides zu
  // zeigen waere Rauschen — der Datenstand haengt darum im title.
  const stamp = document.getElementById('stamp');
  stamp.textContent = t('hud.poll', {
    time: new Date(app.lastPollMs).toLocaleTimeString(locale()),
  });
  stamp.title = t('hud.pollTitle', {
    time: new Date(app.state.generatedAt).toLocaleString(locale()),
  });

  const nav = document.getElementById('planets');
  if (nav.childElementCount !== app.state.planets.length) {
    nav.innerHTML = '';
    for (const p of app.state.planets) {
      const b = document.createElement('button');
      b.textContent = p.label + ' (' + p.hexes.length + ')';
      b.onclick = () => {
        app.planetId = p.id;
        location.hash = p.id; // bookmarkbar: /#privat oeffnet direkt den Planeten
        fitView();
        renderHud();
        scheduleTick();
      };
      nav.append(b);
    }
  }
  [...nav.children].forEach((b, i) =>
    b.setAttribute('aria-pressed', String(app.state.planets[i].id === app.planetId)),
  );
}

export { renderHud };
