import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** Ein einziger Durchlauf durch `~/.claude/projects`.
 *
 *  Vorher liefen `claudeProjects.mjs` und `sessions.mjs` denselben Baum
 *  getrennt ab und statteten jede der ~1100 Dateien doppelt — gemessen
 *  2 x 117 ms von 250 ms einer Erhebung. Beide brauchen aber exakt dieselbe
 *  Information: Pfad, Tiefe, mtime.
 *
 *  Zwei Dinge machen den Unterschied:
 *   - **einmal statt zweimal laufen** (halbiert die Kosten)
 *   - **`stat` parallel statt nacheinander**: sequenziell 86 ms, ueber
 *     `Promise.all` 38 ms. Die Wartezeit liegt im Syscall, nicht in der CPU.
 *
 *  Das Modul zaehlt und interpretiert nichts. Was eine Hauptsession ist, was
 *  ein Subagent, was frisch ist — das entscheiden weiterhin die beiden
 *  Quellen. Hier gibt es nur Dateien mit ihrer Tiefe.
 *
 *  Felder pro Eintrag:
 *   - `dir`     Projektverzeichnis (kodierter Name direkt unter dem Root)
 *   - `path`    absoluter Pfad der .jsonl
 *   - `name`    Dateiname
 *   - `depth`   0 = direkt im Projektverzeichnis (Hauptsession), sonst tiefer
 *   - `parentKey` Session, unter deren `subagents/` die Datei liegt, sonst null
 *   - `mtimeMs` letzte Aenderung
 *   - `size`    Dateigroesse — mit der mtime der Cache-Schluessel in transcript.mjs
 */
export async function scanProjects(root, ignoreDirs = []) {
  let top;
  try {
    top = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];

  /* `parentKey` traegt beim Abstieg die Session mit, zu der Kinder gehoeren:
   * beim Eintritt in ein `subagents/` ist das der Verzeichnisname eine Ebene
   * darueber. Im Transkript eines Subagenten steht keine Parent-ID — das hier
   * ist der einzige Weg zu ihr. */
  async function walk(dir, dirName, depth, parentKey) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        const childParent = e.name === 'subagents' ? basename(dir) : parentKey;
        if (depth < 3) await walk(full, dirName, depth + 1, childParent);
        continue;
      }
      if (!e.name.endsWith('.jsonl')) continue;
      found.push({ dir: dirName, path: full, name: e.name, depth, parentKey: parentKey ?? null });
    }
  }

  for (const e of top) {
    if (!e.isDirectory()) continue;
    if (ignoreDirs.includes(e.name)) continue;
    await walk(join(root, e.name), e.name, 0, null);
  }

  // Erst alle Pfade sammeln, dann in einem Rutsch statten. Dateien, die
  // zwischen Walk und stat verschwinden, fallen still raus — beide Quellen
  // haben sie vorher schon uebersprungen.
  const stats = await Promise.all(found.map((f) => stat(f.path).catch(() => null)));
  return found
    .map((f, i) => (stats[i] ? { ...f, mtimeMs: stats[i].mtimeMs, size: stats[i].size } : null))
    .filter(Boolean);
}
