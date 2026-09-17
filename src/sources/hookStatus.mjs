import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Was die Sessions selbst ueber ihren Zustand sagen.
 *
 *  Der Hook `hooks/session-status.sh` schreibt bei jedem Ereignis eine
 *  winzige Datei nach ${XDG_RUNTIME_DIR:-/tmp}/agent-colony/<sessionId>.json.
 *  Das ist die Antwort auf die Frage, die das Transkript nur raten kann: ein
 *  Agent, der vier Minuten nachdenkt, sieht dort aus wie einer, der wartet.
 *
 *  Diese Datei ist der eng gefasste Bruch mit "kein eigener Zustand"
 *  (CLAUDE.md, Begruendung in docs/HISTORIE.md): geschrieben wird sie von der
 *  Quelle selbst beim Ereignis, sie liegt auf tmpfs, sie hat mit SessionEnd
 *  einen Gegen-Hook, und ihre Gueltigkeit prueft der Aufrufer unabhaengig.
 *
 *  Bewusst NICHT hier: die Lebendigkeitspruefung. Ob zu einer sessionId noch
 *  ein Prozess gehoert, weiss liveSessions.mjs aus ~/.claude/sessions und
 *  /proc. Ein abgeschossenes Fenster hinterlaesst hier einen Eintrag, der
 *  "working" sagt — er faellt beim Aufrufer raus, nicht hier.
 *
 *  `null` statt leerer Map, wenn das Verzeichnis fehlt: leer hiesse "niemand
 *  arbeitet", unbekannt heisst "frag die Heuristik".
 *
 *  R16: `subagents` steht nicht mehr in der Statusdatei. Ein Read-Modify-
 *  Write auf einer gemeinsamen Datei hat bei parallelen SubagentStart-
 *  Ereignissen Updates verloren (gemessen: 20 parallel ergaben 6). Der Hook
 *  legt stattdessen pro laufendem Subagenten eine leere Markerdatei unter
 *  `<sessionId>.subagents/<agent_id>` an; SubagentStop und SessionEnd raeumen
 *  sie wieder weg. Hier wird die Zahl darum aus den Verzeichniseintraegen
 *  gezaehlt, nicht aus einem Feld gelesen.
 *
 *  Fehlt zu einer Statusdatei das Marker-Verzeichnis, zaehlt das als null
 *  laufende Subagenten -- das ist der Normalfall (die meisten Sessions haben
 *  keine Subagenten, `mkdir` legt das Verzeichnis erst beim ersten an).
 *  Umgekehrt: ein Marker-Verzeichnis ohne zugehoerige Statusdatei erzeugt
 *  keinen Map-Eintrag. Ohne Statusdatei gibt es keine sessionId, unter der
 *  ein Eintrag stehen koennte -- der Leser kennt nur, was aus den .json-
 *  Dateien selbst kommt. Das kann bei SessionEnd kurz auftreten (Datei und
 *  Verzeichnis werden getrennt geloescht, ein Poll kann dazwischenliegen)
 *  und heilt beim naechsten Poll von selbst. */

// Vier Woerter, exakt die der Karte (R24): der Hook bildet eine
// Permission-Abfrage jetzt eindeutig auf `prompt` ab, statt sie mit einer
// anderen Notification unter `waiting` zu vermischen.
const STATES = new Set(['working', 'prompt', 'waiting', 'idle']);

export function hookStatusDir(cfg) {
  return cfg?.hookStatusDir ?? join(process.env.XDG_RUNTIME_DIR || '/tmp', 'agent-colony');
}

/** Anzahl der Markerdateien in `<sessionId>.subagents/`, oder 0 wenn das
 *  Verzeichnis (noch) nicht existiert. Ein Fehlschlag hier darf den
 *  Statuseintrag der Session nicht mitreissen -- lieber 0 als ein Wurf. */
async function countSubagents(dir, sessionId) {
  try {
    const entries = await readdir(join(dir, `${sessionId}.subagents`));
    return entries.length;
  } catch {
    return 0;
  }
}

export async function loadHookStatus(cfg) {
  const dir = hookStatusDir(cfg);

  let names;
  try {
    names = await readdir(dir);
  } catch {
    return null; // Hook nicht installiert oder tmpfs nach Reboot leer
  }

  const out = new Map();
  await Promise.all(
    names
      .filter((n) => n.endsWith('.json') && !n.startsWith('.'))
      .map(async (n) => {
        let rec;
        try {
          rec = JSON.parse(await readFile(join(dir, n), 'utf8'));
        } catch {
          return; // halb geschrieben oder gerade ersetzt — naechster Poll hat sie
        }
        if (!rec.sessionId || !STATES.has(rec.status)) return;
        out.set(rec.sessionId, {
          status: rec.status,
          since: typeof rec.since === 'string' ? rec.since : null,
          subagents: await countSubagents(dir, rec.sessionId),
        });
      }),
  );
  return out;
}

if (process.argv[1]?.endsWith('hookStatus.mjs')) {
  const map = await loadHookStatus({});
  console.log(map ? Object.fromEntries(map) : 'Statusverzeichnis nicht lesbar');
}
