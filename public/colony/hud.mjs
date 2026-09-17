/* Die Leiste oben: Zaehler, ihre Hover-Cards, Planetenwahl, Uhr-Stempel. */

/* Nur die eine Komponente, nicht das Sammelbundle: Shoelaces dist/ importiert
 * in sich selbst relativ, ein einzelnes Modul zieht also alles Noetige nach.
 * Die Importmap in index.html loest den blanken Namen auf. */
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';

import { escapeHtml, familyDot } from './html.mjs';
import { index, reorderWouldMove, rootOf } from './hexmap.mjs';
import { fitView, mode, scheduleTick, setMode } from './renderer.mjs';
import { app, planet } from './store.mjs';

/* Die HUD-Zaehler.
 *
 * `tip` haengt einen Hover-Card an die Zahl: ein Satz, was ueberhaupt gezaehlt
 * wird, darunter die Aufschluesselung nach Projekt. Die Erklaersaetze nennen
 * die echten Schwellwerte aus `config/colony.config.json` — wer sie dort
 * aendert, muss sie hier nachziehen; ein zweiter Weg, sie zur Laufzeit
 * einzublenden, waere mehr Apparat als die Sache wert.
 *
 * `pick` filtert die Agenten aller Planeten, `rows` ist der Ausweg fuer
 * Zaehler, die keine Agenten zaehlen (Sessions, Hangar). */
const HUD_GROUPS = [
  [
    {
      key: 'projects',
      label: 'Projekte',
      tip: {
        title: 'Projekte',
        hint: 'Ein Feld ist ein Git-Repo-Root, nicht ein Vault-Projekt. Sub-Repos unterhalb eines Feldes zaehlen mit. Gezaehlt wird ueber alle Planeten — auf der Karte liegt immer nur einer.',
        rowsLabel: 'Felder',
        planets: (p) => p.hexes.length,
      },
    },
    {
      key: 'satellites',
      label: 'Sub-Repos',
      tip: {
        title: 'Sub-Repos',
        hint: 'Eigene Git-Repos unterhalb eines Feldes, bis Tiefe 2 entdeckt. Sie zaehlen bei dirty und unpushed mit, auch wenn ihre Familie gerade zugeklappt ist — der Zaehler beschreibt den Bestand, nicht die Sicht.',
        rowsLabel: 'Sub-Repos',
        planets: (p) => p.hexes.filter((h) => h.parentId).length,
      },
    },
    {
      key: 'dirty',
      label: 'dirty',
      tone: 'alert',
      tip: {
        title: 'dirty',
        ring: 'dirty',
        hint: 'Uncommittete Aenderungen im Arbeitsverzeichnis, gezaehlt als Zeilen aus git status. Bei Repos mit Worktrees zaehlt nur das Hauptrepo — ein dirty Worktree bleibt hier unsichtbar.',
        rowsLabel: 'Dateien',
        empty: 'alles committet',
        rows: (h) => (h.gitState === 'dirty' ? h.dirty : null),
      },
    },
    {
      key: 'unpushed',
      label: 'unpushed',
      tip: {
        title: 'unpushed',
        ring: 'unpushed',
        hint: 'Commits liegen lokal und nicht auf dem Remote. Ein Repo ganz ohne Upstream zaehlt ebenfalls mit, sobald es zuletzt Commits gab — wie viele dort fehlen, ist nicht messbar.',
        rowsLabel: 'Commits voraus',
        empty: 'alles gepusht',
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
    {
      key: 'agents',
      label: 'Agenten',
      tip: {
        title: 'Agenten',
        hint: 'Jede erhobene Session: Hauptsession oder Subagent, dessen Transkript in den letzten 24 Stunden geschrieben wurde. Aeltere fallen aus der Erhebung. Als Figur steht auf der Karte nur, wessen Fenster noch offen ist — alle uebrigen listet das Panel des Feldes mit "beendet".',
        pick: () => true,
      },
    },
    {
      key: 'open',
      label: 'offen',
      tip: {
        title: 'offene Fenster',
        hint: 'Hauptsessions mit lebendem Prozess laut ~/.claude/sessions. Subagenten haben keinen eigenen Prozess und zaehlen nie mit. Sessions von der Windows-Seite fehlen hier.',
        pick: (a) => a.open === true && !a.sub,
      },
    },
    {
      key: 'working',
      label: 'arbeiten',
      tone: 'ok',
      tip: {
        title: 'arbeitet',
        dot: 'working',
        hint: 'Am Transkript wurde in den letzten 3 Minuten geschrieben. Ob dahinter ein Tool laeuft oder der Agent nachdenkt, ist von aussen nicht zu unterscheiden.',
        pick: (a) => a.state === 'working',
      },
    },
    {
      key: 'prompt',
      label: 'fragen',
      tone: 'alert',
      tip: {
        title: 'fragt',
        dot: 'prompt',
        hint: 'Ein Tool-Aufruf steht seit mindestens einer Minute offen, ohne Ergebnis — meist eine Permission-Abfrage, manchmal nur ein lang laufendes Tool.',
        pick: (a) => a.state === 'prompt',
      },
    },
    {
      key: 'waiting',
      label: 'warten',
      tone: 'warn',
      tip: {
        title: 'wartet auf mich',
        dot: 'waiting',
        hint: 'Mit installiertem Status-Hook: der Turn ist beendet, seitdem keine Reaktion. Ohne Hook: 3 bis 90 Minuten Stille seit der letzten Antwort. Subagenten zaehlen hier nie mit — ihnen antwortet ihr Parent, nicht ich.',
        pick: (a) => a.state === 'waiting',
      },
    },
    {
      key: 'sessions',
      label: 'Sessions',
      tip: {
        title: 'Sessions',
        hint: 'Alle Transkripte in den Projektverzeichnissen, auch lange abgeschlossene. Anders als die Agenten ohne 24-Stunden-Fenster — die Zahl waechst, sie faellt nie.',
        rows: (h) => h.sessions.total,
      },
    },
    {
      key: 'unassigned',
      label: 'im Hangar',
      hideWhenZero: true,
      tip: {
        title: 'Hangar',
        hint: 'Agenten, deren Arbeitsverzeichnis sich keinem Repo zuordnen liess — etwa weil im Transkript nur noch Scratchpad-Pfade stehen.',
        station: true,
      },
    },
  ],
];

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
        rows.push({ label: a.name ?? a.agentType ?? 'Session', sort: 1, text: '1' });
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
function tipContent(tip, value) {
  const { shown, rest, restN } = tipRows(tip);
  const body = shown.length
    ? (tip.rowsLabel ? '<li class="unit"><span>' + escapeHtml(tip.rowsLabel) + '</span></li>' : '') +
      shown
        .map(
          (r) =>
            '<li' + (r.title ? ' title="' + escapeHtml(r.title) + '"' : '') + '><span>' +
            (r.dot ?? '') + escapeHtml(r.label) + '</span><b>' + r.text + '</b></li>',
        )
        .join('') +
      (rest ? '<li class="more"><span>' + rest + ' weitere</span><b>' + restN + '</b></li>' : '')
    : '<li class="empty"><span>' + (tip.empty ?? 'gerade niemand') + '</span></li>';
  return (
    '<div class="tip-head">' +
    (tip.dot ? '<i class="dot ' + tip.dot + '"></i>' : '') +
    (tip.ring ? '<i class="ring ' + tip.ring + '"></i>' : '') +
    '<span>' + escapeHtml(tip.title) + '</span><b>' + value + '</b></div>' +
    '<p>' + escapeHtml(tip.hint) + '</p>' +
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
      trigger.append(value, ' ' + item.label);

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
    if (content) content.innerHTML = tipContent(item.tip, n);
  }
  /* Der Knopf sagt an, ob es etwas zu ordnen gibt. Meist gibt es das nicht:
   * nach dem ersten Druck liegt die Karte im Gewichts-Optimum, und der
   * Auto-Umordner haelt sie dort. Gedimmt heisst "nichts zu tun", nicht
   * "kaputt" — deaktiviert wird er nicht, ein Druck darf immer erlaubt
   * sein. Der Trockenlauf kostet ein Layout ueber gut zwanzig Felder. */
  const reorderBtn = document.getElementById('reorder');
  const leer = !reorderWouldMove(planet()?.hexes ?? [], app.collapsed);
  reorderBtn.classList.toggle('leer', leer);
  reorderBtn.title = leer
    ? 'Nichts umzuordnen — die Karte liegt bereits nach Aufmerksamkeit'
    : 'Karte einmal nach Aufmerksamkeit neu ordnen';

  document.getElementById('mode3d').setAttribute('aria-pressed', String(mode() === '3d'));
  const kitBtn = document.getElementById('modekit');
  kitBtn.hidden = mode() !== '3d';
  kitBtn.setAttribute('aria-pressed', String(app.skin?.() === 'kit'));
  // Der Poll-Zeitpunkt ist der Fetch hier im Browser; der Server cached seinen
  // Zustand einige Sekunden, `generatedAt` kann also aelter sein. Beides zu
  // zeigen waere Rauschen — der Datenstand haengt darum im title.
  const stamp = document.getElementById('stamp');
  stamp.textContent = 'Poll ' + new Date(app.lastPollMs).toLocaleTimeString('de-DE');
  stamp.title =
    'Datenstand der Erhebung: ' + new Date(app.state.generatedAt).toLocaleString('de-DE');

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
