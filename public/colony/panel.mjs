/* Das Detail-Panel rechts: Kennzahlen, Agentenliste, Links nach VS Code und
 * in den Vault. Reines DOM, kein Canvas. */

import { groupAgents } from './agents.mjs';
import { escapeHtml, familyDot } from './html.mjs';
import { t } from './i18n.mjs';
import { childrenOf, index, rootOf } from './hexmap.mjs';
import { app, planet } from './store.mjs';

/* Der Git-Zustand in Worten. Die Texte stehen in den Sprachdateien unter
 * `panel.git.<zustand>`; die Legende hat fuer dieselben Zustaende ihre eigenen,
 * kuerzeren (`legend.git.*`) — im Panel ist Platz fuer einen ganzen Satz. */
const gitLabel = (state) => t('panel.git.' + state);

/* Rueckmeldung zum letzten Klick auf eine Agentenzeile, an deren Agenten-Key
 * gebunden. Sie muss ausserhalb des Renderns liegen, weil das Panel bei jedem
 * Poll (5 s) neu gezeichnet wird — ein Text, der nur im DOM staende, waere
 * weg, bevor der Leser ihn gelesen hat. Erfolg loescht den Merker wieder: der
 * geoeffnete Tab ist die Meldung. */
let note = null;

/* Ein Klick ist unterwegs. Der Weg dauert im kalten Fall zwanzig Sekunden;
 * ohne die Sperre startet jeder weitere Klick in dieser Zeit einen zweiten
 * Lauf, der dasselbe Fenster noch einmal aufmacht. */
let busy = false;

/* Zu welcher Figur die Liste zuletzt gescrollt wurde. Ohne diesen Merker
 * risse das Panel bei jedem Poll (5 s) die markierte Zeile erneut in den
 * Blick — auch dann, wenn der Leser gerade woanders in der Liste liest. */
let scrolledTo = null;

/* VS-Code-Link ueber WSL-Remote. Die Distro kommt aus der Config bzw. aus
 * WSL_DISTRO_NAME des Servers — ohne sie ist die URI sinnlos, dann kein Link. */
function vscodeLink(path) {
  const distro = app.state?.config?.wslDistro;
  if (!distro) return '';
  return (
    '<a class="open" href="vscode://vscode-remote/wsl+' +
    encodeURIComponent(distro) + path + '">' + escapeHtml(t('panel.openInVscode')) + '</a>'
  );
}

function renderPanel(h) {
  const body = document.getElementById('panel-body');

  // Die Rueckmeldung gehoert zu dem Feld, in dem geklickt wurde. Wer weiter-
  // klickt, soll sie nicht spaeter an einem anderen Feld wiederfinden.
  if (note && note.hexId !== h.id) note = null;

  // Ohne WSL-Distro fuehrt der Weg nach VS Code nirgendwohin (vscode.mjs
  // braucht sie fuer den Fenstertitel). Dann ist der Knopf tot statt
  // scheinbar bereit — dieselbe Regel wie beim Link darueber.
  const canOpen = Boolean(app.state?.config?.wslDistro);

  let gitDetail = gitLabel(h.gitState);
  if (h.gitState === 'dirty') gitDetail += ' ' + t('panel.gitDirty', { n: h.dirty });
  if (h.gitState === 'unpushed') {
    gitDetail +=
      ' ' + (h.hasUpstream ? t('panel.gitAhead', { n: h.ahead }) : t('panel.gitNoUpstream'));
  }

  // `state: null` heisst: kein eigenes Transkript, keine eigene
  // Aktivitaetshistorie -- nicht zwingend "hier hat nie ein Agent
  // gearbeitet", eine familienintern umgehaengte Figur (sessions.mjs) kann
  // trotzdem hier stehen (siehe Agentenliste unten). Ein Strich ist die
  // ehrliche Angabe fuer die Aktivitaets-Zeile, "stale · vor 0d" waere
  // gelogen.
  const rows = [
    [
      t('panel.row.activity'),
      h.state === null
        ? '—'
        : t('panel.activity', { state: t('hexState.' + h.state), days: h.daysSinceActivity }),
    ],
    [
      t('panel.row.sessions'),
      t('panel.sessionsValue', { total: h.sessions.total, fresh: h.sessions.fresh }),
    ],
    // Bewusst als Gesamtzahl beschriftet: das sind alle je gestarteten
    // Subagenten, nicht die Figuren, die gerade auf dem Feld stehen.
    [t('panel.row.subagents'), t('panel.subagentsValue', { n: h.subagents })],
    [t('panel.row.git'), gitDetail],
    [t('panel.row.branch'), h.branch ?? '—'],
    [t('panel.row.commits7d'), h.isRepo ? h.commits7d : '—'],
  ];

  // Name und Aufgabe stammen aus dem .meta.json neben dem Transkript. Fehlt
  // es, bleibt die Zeile beim Pfad — nichts wird aus dem Prompt geraten.
  //
  // `pending` ist der Rohbefund "tool_use ohne tool_result" — bewusst nicht
  // als "Permission-Abfrage" beschriftet, weil ein lang laufender Bash-Lauf
  // identisch aussieht. Der Leser bekommt Tool und Dauer und entscheidet.
  //
  // `open` kommt aus der Prozess-Registry, nicht aus dem Transkript: "offen"
  // heisst, der Claude-Prozess lebt; "beendet" heisst, er ist weg. Ohne
  // Registry (null) steht nichts — lieber keine Angabe als eine geratene.
  //
  // `gemeldet` heisst: der Zustand kommt aus einem Hook der Session selbst,
  // nicht aus dem Transkript. Ohne die Marke ist es die Heuristik — und die
  // kann einen nachdenkenden Agenten fuer einen wartenden halten. Die
  // Unterscheidung gehoert sichtbar ins Panel, nicht in den Kommentar.
  //
  // `liveSubagents` ist derselbe Hook-Befund, aber eine andere Zahl als die
  // "Subagenten: N insgesamt"-Zeile weiter oben: dort stehen alle je
  // gestarteten, hier nur die gerade laufenden. Deshalb der eigene Wortlaut
  // "laufen" statt "insgesamt" -- wer beide Zahlen nebeneinander liest, darf
  // sie nicht verwechseln koennen. `null` (kein Hook, oder eine
  // Subagenten-Figur selbst) zeigt nichts, ebenso `0` (der Normalfall: die
  // meisten Sessions haben gerade keinen laufenden Subagenten) -- sonst
  // stuende an praktisch jeder gemeldeten Figur "0 Subagenten laufen" (I1).
  //
  // Das Oeffnen der Session haengt an einem eigenen kleinen Knopf am Ende der
  // Zeile, nicht an der Zeile selbst (Andre, 2026-09-14: "dann klickt man
  // dort nicht aus versehen drauf"). Die Zeile bleibt Text, den man
  // markieren und lesen kann; nur der Knopf startet etwas, das Fenster
  // aufreisst. Weg und Grenzen stehen in src/vscode.mjs.
  //
  // Bei einer Subagenten-Figur zeigt sessionId auf die Hauptsession (so legt
  // sessions.mjs sie an). Das ist gewollt: beantworten laesst sich nur dort,
  // und der Knopf sagt es im Titel.
  const openBtn = (a) => {
    if (!a.sessionId || !canOpen) return '';
    return (
      ' <button type="button" class="open-session" data-session="' +
      escapeHtml(a.sessionId) + '" data-key="' + escapeHtml(a.key) + '" title="' +
      escapeHtml(t(a.sub ? 'panel.openParentTitle' : 'panel.openOwnTitle')) +
      '">' + escapeHtml(t('panel.open')) + '</button>'
    );
  };

  const agentEntry = (a) => {
    // Typwache statt roher `> 0`-Vergleich: `n` ist immer eine echte Zahl,
    // bevor sie ungeprueft in HTML interpoliert wird. Heute unerreichbar
    // (siehe Kommentar oben), aber die Bedingung soll nicht zwei Aufgaben
    // tragen -- pruefen und interpolieren getrennt.
    const n = Number.isInteger(a.liveSubagents) ? a.liveSubagents : 0;
    // Die angeklickte Figur (app.markedAgent) traegt ihre Zeile hervorgehoben,
    // damit der Weg von der Karte in die Liste sichtbar ist. Mehr als die
    // Hervorhebung passiert nicht: die Zeile bleibt Text, geoeffnet wird ueber
    // den Knopf.
    return '<div class="agent' + (app.markedAgent === a.key ? ' marked' : '') +
    '" data-key="' + escapeHtml(a.key) + '">' +
    '<span class="tag ' + a.state + '">' + escapeHtml(t('agent.' + a.state)) + '</span> ' +
    escapeHtml(t('panel.minutes', { n: a.ageMinutes })) +
    (a.open === true
      ? ' · ' + escapeHtml(t('panel.agentOpen'))
      : a.open === false
        ? ' · ' + escapeHtml(t('panel.agentEnded'))
        : '') +
    (a.statusSource === 'hook'
      ? ' <span class="tag src">' + escapeHtml(t('panel.reported')) + '</span>'
      : '') +
    (n > 0
      ? ' <span class="tag src">' + escapeHtml(t('panel.liveSubagents', { n })) + '</span>'
      : '') +
    (a.name ? ' <b>' + escapeHtml(a.name) + '</b>' : '') +
    (a.gitBranch ? ' <span class="tag">' + escapeHtml(a.gitBranch) + '</span>' : '') +
    (a.pending
      ? '<br><span class="pending">' +
        escapeHtml(t('panel.pending', { tool: a.pending.tool, n: a.pending.minutes })) +
        '</span>'
      : '') +
    (a.task ? '<br><span class="task">' + escapeHtml(a.task) + '</span>' : '') +
    '<br><code>' + escapeHtml(a.cwd) + '</code>' +
    openBtn(a) +
    (note?.key === a.key
      ? '<br><span class="open-note ' + note.kind + '">' + escapeHtml(note.text) + '</span>'
      : '') +
    '</div>';
  };

  const groups = groupAgents(h.agents);
  const agentList = groups.length
    ? groups
        .map(
          (g) =>
            '<li>' +
            (g.head
              ? agentEntry(g.head)
              : '<span class="tag">' + escapeHtml(t('panel.headElsewhere')) + '</span>') +
            (g.kids.length
              ? '<ul class="kids">' +
                g.kids.map((k) => '<li>' + agentEntry(k) + '</li>').join('') +
                '</ul>'
              : '') +
            '</li>',
        )
        .join('')
    : '<li style="color:var(--muted)">' + escapeHtml(t('panel.noAgents')) + '</li>';

  // Mehrere Verzeichnisse = Worktrees oder Unterordner desselben Repos
  const memberList =
    h.members.length > 1
      ? '<dl><dt>' + escapeHtml(t('panel.row.also')) + '</dt><dd>' +
        h.members
          .filter((m) => m !== h.path)
          .map((m) => '<code>' + escapeHtml(m) + '</code>')
          .join('<br>') +
        '</dd></dl>'
      : '';

  const hexes = planet()?.hexes ?? [];
  const kids = childrenOf(hexes, h.id);
  const parent = h.parentId ? hexes.find((x) => x.id === h.parentId) : null;

  // Der Deckel ist eine Aussage, keine Fehlanzeige: das Feld hat Unter-Repos,
  // sie sind nur zu viele fuer eine Familie.
  const cappedRow = h.satellitesCapped
    ? '<dl><dt>' + escapeHtml(t('panel.row.capped')) + '</dt><dd>' +
      escapeHtml(t('panel.cappedValue', { n: h.satellitesCapped })) + '</dd></dl>'
    : '';

  const familyRow = kids.length
    ? '<dl><dt>' + escapeHtml(t('panel.row.subRepos')) + '</dt><dd><ul class="subs">' +
      kids.map((k) =>
        '<li><code>' + escapeHtml(k.title) + '</code>' +
        '<span class="tag">' + escapeHtml(gitLabel(k.gitState)) + '</span></li>').join('') +
      '</ul></dd></dl><button id="collapse" class="open alt">' +
      escapeHtml(t(app.collapsed.has(h.id) ? 'panel.expandFamily' : 'panel.collapseFamily')) +
      '</button>'
    : '';

  // Die Spec verlangt: "ein Satellit nennt seinen Parent und springt hin."
  // Der Sprung lief bisher nicht mit — nur der Name stand da. Knopf statt
  // Link auf dem Pfad selbst, damit der Pfadtext weiter reiner Text bleibt
  // und wie ueberall sonst im Panel selektierbar ist.
  const parentRow = parent
    ? '<dl><dt>' + escapeHtml(t('panel.row.parent')) + '</dt><dd><code>' +
      escapeHtml(parent.path) + '</code></dd></dl>' +
      '<button id="jump-parent" class="open alt">' +
      escapeHtml(t('panel.jumpParent')) + '</button>'
    : '';

  // Der Familienpunkt steht am Titel jedes Familienmitglieds, Wurzel
  // eingeschlossen — sonst weiss man, dass Zeilen zusammengehoeren, aber
  // nicht zu wem.
  const idx = index(hexes);
  const root = rootOf(h, idx);
  const inFamily = root !== h || kids.length > 0;
  const dot = inFamily ? familyDot(root.path) : '';

  body.innerHTML =
    '<h2>' + dot + escapeHtml(h.title) + '</h2>' +
    '<code>' + escapeHtml(h.path) + '</code>' +
    '<dl>' + rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + escapeHtml(v) + '</dd>').join('') + '</dl>' +
    memberList + parentRow + familyRow + cappedRow +
    vscodeLink(h.path) +
    (h.note
      ? ' <a class="open alt" href="' + h.note.obsidianUri + '">' +
        escapeHtml(t('panel.note', { title: h.note.title })) + '</a>'
      : '') +
    '<ul>' + agentList + '</ul>';

  // Der Knopf existiert nur bei Containern, darum optional verdrahtet. Der
  // Callback laeuft in colony.js, weil dort layout()/draw() ohne Zyklus
  // zwischen panel.mjs und map.mjs erreichbar sind.
  const btn = document.getElementById('collapse');
  if (btn) btn.onclick = () => app.toggleFamily?.(h.id);

  // Existiert nur bei Satelliten, genauso optional verdrahtet wie der
  // Zuklapp-Knopf — `app.selectHex` fehlt nie im Normalbetrieb, aber ein
  // fehlender Callback soll hier folgenlos bleiben statt zu werfen.
  const jumpBtn = document.getElementById('jump-parent');
  if (jumpBtn) jumpBtn.onclick = () => app.selectHex?.(parent.id);

  // Ein Handler auf der Liste statt einer je Zeile, und als `onclick` gesetzt
  // statt addEventListener: renderPanel laeuft bei jedem Poll erneut, ein
  // Zuweisen ist idempotent, ein Hinzufuegen waere es nicht.
  //
  // Der Pfad kommt vom Feld, nicht aus a.cwd: ein Hexfeld ist der Repo-Root,
  // und ein Fenster oeffnet man auf das Repo, nicht auf einen Unterordner
  // (Worktrees eines Repos sind eigene Felder und tragen darum ihren eigenen
  // Pfad). Der Server prueft ihn ohnehin gegen die eigene Erhebung.
  body.onclick = async (ev) => {
    const el = ev.target.closest?.('button.open-session');
    if (!el) return;
    if (busy) return;
    busy = true;
    const key = el.dataset.key;
    note = { key, hexId: h.id, text: t('panel.opening'), kind: 'wait' };
    renderPanel(h);
    let done;
    try {
      const res = await fetch('/api/open-session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: h.path, sessionId: el.dataset.session }),
      });
      const data = await res.json().catch(() => ({}));
      done = data.ok
        ? null
        : {
            key,
            hexId: h.id,
            text: data.error ?? t('panel.error', { status: res.status }),
            kind: 'bad',
          };
    } catch (err) {
      done = { key, hexId: h.id, text: err.message, kind: 'bad' };
    }
    note = done;
    busy = false;
    // Zwischen Klick und Antwort koennen dreissig Sekunden liegen (ein kaltes
    // VS Code braucht sie). Wer inzwischen ein anderes Feld angeklickt hat,
    // soll nicht das alte Panel zurueckbekommen.
    if (app.selected?.id === h.id) renderPanel(app.selected);
  };

  document.getElementById('panel').hidden = false;

  // Die markierte Zeile in den Blick holen, aber nur einmal je Figur: das
  // Panel zeichnet sich bei jedem Poll neu, ein Scroll je Runde waere ein
  // Zucken. `block: 'nearest'` scrollt nur, wenn die Zeile wirklich ausserhalb
  // liegt, und bewegt die Seite darum nicht, wenn sie schon zu sehen ist.
  if (app.markedAgent && scrolledTo !== app.markedAgent) {
    scrolledTo = app.markedAgent;
    body
      .querySelector(`.agent.marked`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  if (!app.markedAgent) scrolledTo = null;
}

export { renderPanel };
