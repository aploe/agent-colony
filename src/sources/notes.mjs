import { readdir } from 'node:fs/promises';
import { basename } from 'node:path';

/** Normalisiert fuer den Namensvergleich: Kleinschreibung, alles ausser
 *  Buchstaben und Ziffern raus. "shop4-webapp" und "Shop4 Webapp"
 *  treffen sich damit, "10_garden" und "Garden" nicht. */
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Optionaler Vault-Bezug. Die Notizen steuern die Darstellung **nicht** —
 *  sie liefern nur einen Sprung ins Second Brain, wenn es dort etwas gibt.
 *  Zuerst das explizite noteMapping, danach exakter Namensvergleich. */
export async function attachNotes(hexes, cfg) {
  if (!cfg.vaultPath || !cfg.projectsDir) return; // kein Vault konfiguriert
  let files;
  try {
    files = (await readdir(`${cfg.vaultPath}/${cfg.projectsDir}`))
      .filter((f) => f.endsWith('.md'));
  } catch {
    return; // kein Vault erreichbar (z.B. OneDrive offline) — kein Fehler
  }

  const byTitle = new Map(files.map((f) => [f.replace(/\.md$/, ''), f]));
  const byNorm = new Map(files.map((f) => [norm(f.replace(/\.md$/, '')), f]));

  for (const h of hexes) {
    const mapped = cfg.noteMapping?.[h.path];
    const file = (mapped && byTitle.get(mapped)) ?? byNorm.get(norm(basename(h.path)));
    if (!file) continue;

    const rel = `${cfg.projectsDir}/${file}`;
    h.note = {
      title: file.replace(/\.md$/, ''),
      path: rel,
      obsidianUri:
        `obsidian://open?vault=${encodeURIComponent(cfg.vaultName)}` +
        `&file=${encodeURIComponent(rel.replace(/\.md$/, ''))}`,
    };
  }
}
