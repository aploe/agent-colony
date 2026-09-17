import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Registry der laufenden Claude-Code-Prozesse — die Antwort auf die Frage
 *  "ist diese Session noch offen, oder rate ich das aus dem Transkript?".
 *
 *  Claude Code schreibt beim Start jedes Prozesses eine Datei
 *  `~/.claude/sessions/<pid>.json` mit `pid`, `sessionId`, `cwd`,
 *  `startedAt` und `procStart` — interaktiv wie headless (`claude -p`
 *  registriert sich nach ~1 s, gemessen 2026-09-10) — und loescht sie beim
 *  sauberen Ende wieder. Was liegen bleibt, stammt von abgeschossenen
 *  Prozessen (VS-Code-Fenster zu, WSL neu gestartet): auf dieser Maschine
 *  18 von 28 Eintraegen. Die Datei allein beweist also nichts.
 *
 *  Der Beweis ist `procStart`: Feld 22 aus /proc/<pid>/stat, die Startzeit
 *  des Prozesses in Kernel-Ticks seit Boot. PID lebt **und** Startzeit
 *  stimmt heisst: das ist noch derselbe Prozess, keine wiederverwendete PID.
 *  Nach einem Neustart passt keine alte Startzeit mehr, die Leichen fallen
 *  von selbst raus.
 *
 *  Kein eigener Zustand: gelesen wird nur, was Claude Code selbst schreibt,
 *  plus /proc. Ein SessionEnd-Hook mit Marker-Datei wuerde genau die
 *  Abstuerze verpassen, deren Eintraege hier liegen bleiben.
 *
 *  Bewusst ignoriert: `pidDomain` (PID-Namespace, relevant fuer Container)
 *  und Sessions von der Windows-Seite — beide haben hier weder /proc-Eintrag
 *  noch Transkript. */

/** Feld 22 (starttime) aus /proc/<pid>/stat, oder null wenn der Prozess
 *  weg ist. Feld 2 ist der Prozessname in Klammern und darf Leerzeichen
 *  enthalten, darum hinter der letzten ')' zaehlen — dort beginnt Feld 3.
 *  Ein Zombie (Feld 3 = 'Z') traegt noch seine Startzeit, tut aber nichts
 *  mehr, und zaehlt deshalb als weg. */
async function procStartOf(pid) {
  let text;
  try {
    text = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(' ');
  if (fields[0] === 'Z') return null;
  return fields[19] ?? null;
}

/** Offene Sessions als Map sessionId -> { pid, cwd, startedAt, kind }.
 *
 *  `null`, wenn die Registry nicht lesbar ist (aelteres Claude Code, anderes
 *  Home): dann bleibt der Aufrufer bei seiner Zeit-Heuristik, statt jede
 *  Session fuer geschlossen zu erklaeren. */
export async function loadLiveSessions(cfg) {
  const dir = cfg.claudeSessionsDir
    ?? (cfg.claudeProjectsDir ? join(dirname(cfg.claudeProjectsDir), 'sessions') : null)
    ?? join(homedir(), '.claude', 'sessions');

  let names;
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }

  const live = new Map();
  await Promise.all(
    names
      .filter((n) => /^\d+\.json$/.test(n))
      .map(async (n) => {
        let rec;
        try {
          rec = JSON.parse(await readFile(join(dir, n), 'utf8'));
        } catch {
          return; // halb geschrieben oder gerade geloescht
        }
        if (!rec.sessionId || !rec.pid || !rec.procStart) return;
        if ((await procStartOf(rec.pid)) !== String(rec.procStart)) return;
        // Eine per --resume fortgesetzte Session hat zwei Eintraege mit
        // derselben sessionId — einen toten und einen lebenden. Hier landet
        // nur der lebende, die Reihenfolge ist egal.
        //
        // `startedAt` kommt roh aus der Datei: ein unparsbarer Wert (kaputt
        // geschriebene Zahl, kein ISO-String) wuerde `toISOString()` mit
        // einem RangeError werfen lassen und ungefangen die ganze Erhebung
        // umreissen — genau das Szenario, gegen das das JSON.parse oben schon
        // absichert. Lieber null als ein Wurf.
        const started = rec.startedAt ? new Date(rec.startedAt) : null;
        live.set(rec.sessionId, {
          pid: rec.pid,
          cwd: rec.cwd ?? null,
          startedAt: started && !Number.isNaN(started.getTime()) ? started.toISOString() : null,
          kind: rec.kind ?? null,
        });
      }),
  );
  return live;
}

if (process.argv[1]?.endsWith('liveSessions.mjs')) {
  const live = await loadLiveSessions({});
  console.log(live ? Object.fromEntries(live) : 'Registry nicht lesbar');
}
