import { open } from 'node:fs/promises';

/** Transkript-Schwaenze lesen und deuten — gemeinsam fuer claudeProjects.mjs
 *  (Aktivitaet eines Feldes) und sessions.mjs (Agenten-Figuren).
 *
 *  Aktivitaet ist der Zeitstempel des juengsten Rollen-Records (user oder
 *  assistant), nicht die Datei-mtime. Die mtime aendert sich auch, wenn
 *  niemand gearbeitet hat: am 2026-09-11 schrieb ein Projekt-Umzug per
 *  `sed -i` 271 Transkripte um, und die Karte zeigte 271 Agenten, 149 davon
 *  "wartet auf mich", dazu jedes betroffene Feld gruen mit "0d". Die mtime
 *  taugt weiter als billiger Vorfilter — eine Datei mit alter mtime kann
 *  keinen neuen Record haben — aber nicht als Aussage.
 *
 *  Die Deutung wird je Datei gecacht, Schluessel Pfad, gueltig solange
 *  mtime und Groesse gleich sind: ein Transkript aendert sich nicht, ohne
 *  dass sich seine mtime aendert. Ohne den Cache kostete der Umzug rund
 *  300 ms Schwanzlesen pro Poll, 24 Stunden lang (412 statt ~110 ms je
 *  Erhebung). Nur In-Memory, faellt mit dem Prozess; Eintraege zu
 *  verschwundenen Dateien bleiben liegen, das sind ein paar hundert kleine
 *  Objekte. */

const TAIL_BYTES = 65536;
const TAIL_MAX_BYTES = 1048576;

/** Liest nur den Dateischwanz. Transkripte werden hier bis zu 9 MB gross —
 *  readFile() ueber >1000 Dateien waere pro Refresh im Gigabyte-Bereich.
 *  `whole` sagt, ob der Schwanz schon die ganze Datei war. */
async function readTail(file, bytes) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, size));
    await fh.read(buf, 0, buf.length, start);
    return { text: buf.toString('utf8'), whole: start === 0 };
  } finally {
    await fh.close();
  }
}

/** Rollen-Records vom Dateiende her. 64 KB reichen fast immer. Wenn nicht,
 *  viermal so weit zurueck, bis 1 MB — dann aufgeben, denn die ganze Datei
 *  zu lesen ist genau das, was hier nie passieren darf.
 *
 *  Warum ueberhaupt: eine einzelne `prompt_snapshot`-Zeile ist bis 160 KB
 *  lang. Landet der Fensteranfang mittendrin, sind die einzigen ganzen
 *  Zeilen dahinter `last-prompt` und `atis-latch` — kein user, kein
 *  assistant, also keine cwd, keine Rolle. Zwei Test-Sessions ("Antworte
 *  nur mit dem Wort OK") standen deshalb mit leerer cwd im Hangar. Bleibt es
 *  auch nach 1 MB leer, landet die Figur ehrlich dort. */
export async function readRoleRecords(file) {
  for (let bytes = TAIL_BYTES; ; bytes *= 4) {
    const { text, whole } = await readTail(file, bytes);
    const recs = roleRecords(text);
    if (recs.length || whole || bytes >= TAIL_MAX_BYTES) return recs;
  }
}

/** Alle vollstaendigen Datensaetze mit Rollen-Information aus dem Tail, in
 *  Dateireihenfolge. Die erste Zeile des Tails ist fast immer abgeschnitten,
 *  darum zeilenweise parsen und Fehler schlucken. Dazwischen liegen viele
 *  Datensaetze ohne Rolle (attachment, last-prompt, ai-title, mode,
 *  atis-latch, queue-operation, file-history-snapshot, system) — die
 *  fliegen hier raus. */
function roleRecords(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.type === 'user' || rec.type === 'assistant') out.push(rec);
    } catch {
      // abgeschnittene oder kaputte Zeile
    }
  }
  return out;
}

/** Tools, die im Vordergrund legitim minutenlang laufen. Ein offener Aufruf
 *  davon heisst nicht, dass jemand auf mich wartet: `Agent` blockiert,
 *  solange der Subagent arbeitet; `Monitor` und `TaskOutput` warten per
 *  Definition auf ein Ereignis; `Workflow` treibt ein ganzes Skript. */
const LONG_RUNNING_TOOLS = new Set(['Agent', 'Monitor', 'Workflow', 'TaskOutput']);

/** Unbeantworteter Tool-Aufruf: ein `tool_use`-Block, zu dem im Transkript
 *  noch kein `tool_result` steht. Das ist das einzige Signal fuer "Claude
 *  wartet auf eine Erlaubnis / eine Antwort auf AskUserQuestion / eine
 *  Plan-Freigabe" — einen expliziten Marker dafuer schreibt Claude Code
 *  nirgends. Der Preis: ein Bash-Lauf, der wirklich vier Minuten braucht,
 *  sieht genauso aus. Deshalb der Schwellwert `agentPromptMinutes` und die
 *  ehrliche Bezeichnung "unbeantworteter Tool-Aufruf" statt "Permission".
 *
 *  Rueckwaerts gelaufen: erst die `tool_result`-IDs einsammeln, dann jeden
 *  `tool_use` dagegen pruefen. Ein echter User-Prompt (String oder Bloecke
 *  ohne tool_result) beendet die Suche — alles davor ist per Konstruktion
 *  beantwortet. Bei mehreren offenen Aufrufen (parallele Tool-Calls) gewinnt
 *  der aelteste, weil er die laengste Wartezeit traegt. Ein tool_use, dessen
 *  Antwort im abgeschnittenen Tail-Anfang liegt, gibt es nicht: die Antwort
 *  steht immer hinter dem Aufruf, ist also im Tail, wenn er es ist. */
function pendingToolUse(recs) {
  const answered = new Set();
  let pending = null;
  for (let i = recs.length - 1; i >= 0; i--) {
    const rec = recs[i];
    const content = rec.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    if (rec.type === 'user') {
      const results = blocks.filter((b) => b.type === 'tool_result');
      if (!results.length) break;
      for (const b of results) answered.add(b.tool_use_id);
      continue;
    }
    for (const b of blocks) {
      if (b.type !== 'tool_use' || answered.has(b.id)) continue;
      if (LONG_RUNNING_TOOLS.has(b.name)) continue;
      pending = { tool: b.name, since: rec.timestamp ?? null };
    }
  }
  return pending;
}

/** Was aus einem Schwanz gebraucht wird, klein genug zum Cachen: nicht die
 *  Records selbst (ein Assistant-Record traegt seinen ganzen Text), nur die
 *  Felder, die Figur und Feld daraus bauen. */
function analyze(recs) {
  const last = recs[recs.length - 1] ?? null;
  // Juengster Rollen-Record mit Zeitstempel; praktisch immer der letzte.
  let lastMs = null;
  for (let i = recs.length - 1; i >= 0 && lastMs === null; i--) {
    const t = Date.parse(recs[i].timestamp);
    if (!Number.isNaN(t)) lastMs = t;
  }
  // Alle cwds des Tails, neueste zuerst, ohne Doppelte. Ein `cd` in der
  // Session (etwa nach ~/.claude/projects zum Nachsehen) verschiebt die cwd
  // aller folgenden Records — die Zuordnung darf daran nicht scheitern.
  const cwds = [];
  for (let i = recs.length - 1; i >= 0; i--) {
    const c = recs[i].cwd;
    if (c && !cwds.includes(c)) cwds.push(c);
  }
  return {
    lastMs,
    last: last
      ? {
          type: last.type,
          sessionId: last.sessionId ?? null,
          cwd: last.cwd ?? null,
          gitBranch: last.gitBranch ?? null,
          isSidechain: Boolean(last.isSidechain),
        }
      : null,
    cwds,
    open: pendingToolUse(recs),
  };
}

const cache = new Map();

/** Gedeutete Schwanz-Information zu einem Scan-Eintrag ({ path, mtimeMs,
 *  size }). Aus dem Cache, solange mtime und Groesse unveraendert sind. */
export async function tailInfo(entry) {
  const hit = cache.get(entry.path);
  if (hit && hit.mtimeMs === entry.mtimeMs && hit.size === entry.size) return hit.info;
  const info = analyze(await readRoleRecords(entry.path));
  cache.set(entry.path, { mtimeMs: entry.mtimeMs, size: entry.size, info });
  return info;
}

/** Zeitstempel des juengsten Rollen-Records, null wenn der Schwanz keinen hat. */
export async function lastRecordMs(entry) {
  return (await tailInfo(entry)).lastMs;
}
