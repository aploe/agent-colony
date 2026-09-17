/* Die Hover-Card an einem Tagesbalken. Der Balken ist kein DOM-Element,
 * darum bekommt `sl-popup` einen virtuellen Anker. */

// Ein Canvas-Balken hat kein DOM-Element, sl-popup nimmt dafuer einen
// virtuellen Anker (siehe dayTip weiter unten).
import '@shoelace-style/shoelace/dist/components/popup/popup.js';

import { escapeHtml } from './html.mjs';
import { DAY_BASE, DAY_PITCH, DAY_W, DAY_X0, dayHeight } from './skyline.mjs';
import { app, view } from './store.mjs';

/* Hover-Card an einem Tagesbalken der Skyline.
 *
 * Ein Balken ist kein DOM-Element, also bekommt sl-popup einen virtuellen
 * Anker: ein Objekt mit getBoundingClientRect(), das das Rechteck des Balkens
 * in Bildschirmkoordinaten liefert. floating-ui sieht Bewegungen eines
 * virtuellen Ankers nicht von selbst — nach jedem Wechsel reposition(). Ein
 * sl-tooltip taugt hier nicht, der haengt am Trigger-Slot; das sl-popup ist
 * dieselbe Karte ohne diesen Umweg. */
const dayTip = document.createElement('sl-popup');
dayTip.id = 'daytip';
dayTip.setAttribute('placement', 'top');
dayTip.setAttribute('distance', '10');
dayTip.setAttribute('strategy', 'fixed');
dayTip.setAttribute('arrow', '');
const dayTipBody = document.createElement('div');
dayTipBody.className = 'tip';
dayTip.append(dayTipBody);
document.body.append(dayTip);
let dayRect = { x: 0, y: 0, w: 0, h: 0 };
dayTip.anchor = {
  getBoundingClientRect: () => ({
    x: dayRect.x, y: dayRect.y, width: dayRect.w, height: dayRect.h,
    left: dayRect.x, top: dayRect.y, right: dayRect.x + dayRect.w, bottom: dayRect.y + dayRect.h,
  }),
};

function dayLabel(i) {
  const key = app.state?.days?.[i];
  if (!key) return '—';
  // Mittag, damit die Zeitzone das Datum nicht kippt
  return new Date(key + 'T12:00:00').toLocaleDateString('de-DE', {
    weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function dayTipHtml(h, i) {
  const days = h.commitsByDay;
  const n = days[i] ?? 0;
  const total = days.reduce((a, b) => a + b, 0);
  return (
    '<div class="tip-head"><span>' + escapeHtml(dayLabel(i)) + '</span><b>' + n + '</b></div>' +
    '<p>Commits in ' + escapeHtml(h.title) + ' an diesem Tag, Committer-Datum. ' +
    'Die Balkenhoehe misst sich am staerksten Tag aller Projekte (' + app.dayMax + ').</p>' +
    '<ul><li class="unit"><span>Commits</span></li>' +
    '<li><span>letzte 14 Tage</span><b>' + total + '</b></li>' +
    '<li><span>letzte 7 Tage</span><b>' + h.commits7d + '</b></li></ul>'
  );
}

function showDayTip(d) {
  const { hex: h, day: i } = d;
  if (d.rect) {
    // 3D liefert das Rechteck fertig: pick.mjs projiziert den Tagesbau.
    dayRect = d.rect;
  } else {
    const { c } = d;
    const hgt = dayHeight(h.commitsByDay[i] ?? 0);
    const wx = c.x + DAY_X0 + i * DAY_PITCH;
    const wy = c.y + DAY_BASE - hgt;
    // Umkehrung von toWorld(): screen = innerWidth / 2 + view.x + world * zoom
    dayRect = {
      x: innerWidth / 2 + view.x + wx * view.zoom,
      y: innerHeight / 2 + view.y + wy * view.zoom,
      w: DAY_W * view.zoom,
      h: hgt * view.zoom,
    };
  }
  dayTipBody.innerHTML = dayTipHtml(h, i);
  dayTip.active = true;
  // Erst nach dem Lit-Update existiert das Popup-Element, vorher ist
  // reposition() ein Leerlauf.
  dayTip.updateComplete.then(() => dayTip.reposition());
}

function hideDayTip() {
  app.dayHover = null;
  dayTip.active = false;
}

export { hideDayTip, showDayTip };
