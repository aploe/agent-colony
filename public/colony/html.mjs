/* Escaping fuer alles, was als HTML-String ins Panel oder in eine Hover-Card
 * geht. Steht allein, weil Panel, Hover-Card und HUD es gleichermassen
 * brauchen und keines von ihnen der natuerliche Besitzer ist. */

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);

/* Farbpunkt einer Familie, stabil aus dem Pfad ihrer Wurzel. Eine
 * Identitaetsfarbe, keine Zustandsfarbe — und sie existiert nur im DOM
 * (HUD-Card, Panel). Auf der Karte ist Farbe doppelt vergeben (Fuellung =
 * Aktivitaet, Rand = Git); wer den Punkt dorthin bringt, bricht die Legende. */
function familyHue(path) {
  let h = 0;
  for (const ch of path) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

function familyDot(rootPath) {
  return '<i class="fam" style="background:hsl(' + familyHue(rootPath) + ' 55% 58%)"></i>';
}

export { escapeHtml, familyDot, familyHue };
