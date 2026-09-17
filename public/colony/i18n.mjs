/* Beschriftungen in mehreren Sprachen.
 *
 * Es gibt keinen Build und keinen Bundler, also liegen die Sprachtabellen als
 * JSON unter `public/i18n/` und werden geholt wie jede andere Datei. Die
 * Sprache kommt aus der Config des Servers (`language`, Standard `en`) und
 * steht als `config.language` im State; `?lang=fr` in der URL schlaegt sie,
 * damit man eine Sprache ansehen kann, ohne die Config anzufassen (und damit
 * Screenshots aller vier Sprachen gegen einen Server laufen).
 *
 * `en.json` wird immer geladen und die gewaehlte Sprache darueber gelegt: eine
 * unvollstaendige Uebersetzung zeigt damit englische Luecken statt leerer
 * Stellen. Fehlt ein Schluessel in beiden, steht der Schluessel selbst da —
 * sichtbar falsch ist ehrlicher als leer (CLAUDE.md, "Ehrlichkeit vor
 * Vollstaendigkeit").
 *
 * Dieses Modul importiert nichts, wie `store.mjs` und `hexmap.mjs`. Ein
 * Import hier waere das Signal, dass der Schnitt kaputt ist.
 *
 * `t()` wird zur Zeichenzeit gerufen, nie beim Auswerten eines Moduls: eine
 * Tabelle mit fertigen Strings im Modulkopf waere gefuellt, bevor die
 * Sprachdatei da ist. Darum stehen in `hud.mjs` Schluessel, keine Texte.
 */

const FALLBACK = 'en';

let dict = {};
let code = FALLBACK;
let tag = 'en-GB';

/** Eine Sprachdatei holen. Unbekannte Sprache = null, der Aufrufer sagt es. */
async function fetchDict(lang) {
  try {
    const res = await fetch('/i18n/' + encodeURIComponent(lang) + '.json');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* Tief mischen, nicht flach: die gewaehlte Sprache darf einzelne Schluessel
 * eines Astes ueberschreiben, ohne den ganzen Ast mitbringen zu muessen. */
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

/* `de-DE` darf in der Config stehen, auch wenn die Datei `de.json` heisst:
 * erst die volle Kennung versuchen, dann den Sprachteil. */
function candidates(lang) {
  const l = String(lang ?? '').trim().toLowerCase();
  if (!l) return [];
  const short = l.split('-')[0];
  return short === l ? [l] : [l, short];
}

/** Platzhalter `{name}` aus `params` fuellen. Fehlt einer, bleibt er stehen. */
function fill(text, params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

/** Pfad `a.b.c` in der Tabelle nachschlagen. */
function lookup(key) {
  let node = dict;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

/* Ein Text. `params.n` waehlt bei einem Eintrag mit `one`/`other` die Form —
 * fuer die vier Sprachen hier reicht die binaere Regel (1 gegen alles
 * andere); eine echte Pluralbibliothek waere Apparat ohne Anlass. */
function t(key, params) {
  let v = lookup(key);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    v = params?.n === 1 ? v.one : v.other;
  }
  return typeof v === 'string' ? fill(v, params) : key;
}

/** BCP-47-Kennung fuer `toLocaleTimeString` und Freunde. */
const locale = () => tag;

/** Die aktive Sprache, wie sie in `<html lang>` gehoert. */
const lang = () => code;

/* Text setzen, ohne Kindelemente zu verlieren: die Legende traegt ein
 * Farbfeld <i> vor ihrem Text, `textContent` wuerde es loeschen. Darum den
 * letzten Textknoten beschreiben und nur bei einem leeren Element einen
 * anlegen. */
function setText(el, text) {
  for (let i = el.childNodes.length - 1; i >= 0; i--) {
    if (el.childNodes[i].nodeType === Node.TEXT_NODE) {
      el.childNodes[i].data = text;
      return;
    }
  }
  el.append(text);
}

/* Die festen Beschriftungen in `index.html`. Sie stehen dort auf Englisch,
 * damit die Seite auch ohne geladene Sprachdatei lesbar bleibt; hier werden
 * sie ueberschrieben. Idempotent — ein zweiter Aufruf ist folgenlos. */
function applyStatic(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) setText(el, t(el.dataset.i18n));
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nLabel));
  }
  document.documentElement.lang = code;
}

/* Einmal beim Laden, bevor irgendetwas zeichnet. `configured` ist
 * `state.config.language`; die URL schlaegt sie. */
async function initI18n(configured) {
  const wanted = new URLSearchParams(location.search).get('lang') ?? configured;
  dict = (await fetchDict(FALLBACK)) ?? {};
  tag = dict.meta?.locale ?? 'en-GB';
  code = FALLBACK;
  for (const cand of candidates(wanted)) {
    if (cand === FALLBACK) break;
    const over = await fetchDict(cand);
    if (!over) continue;
    dict = merge(dict, over);
    code = cand;
    tag = over.meta?.locale ?? cand;
    break;
  }
  if (wanted && !candidates(wanted).includes(code)) {
    console.warn(`Sprache "${wanted}" nicht gefunden, es bleibt bei ${code}. Dateien: public/i18n/`);
  }
  applyStatic();
}

export { applyStatic, initI18n, lang, locale, t };
