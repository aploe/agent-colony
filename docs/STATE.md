# Der State von `/api/state`

Ausgelagert aus `CLAUDE.md` am 2026-09-14, Inhalt unverändert. Verkürzt;
die Kommentare an `agents[].state` sind die Entscheidungslogik von
`decideState()` in `src/sources/sessions.mjs` in Prosa.

```js
{ generatedAt,
  days: [ 'YYYY-MM-DD' x14 ],             // Kalendertage zu hex.commitsByDay, aeltester zuerst
  config: { wslDistro,                    // fuer den VS-Code-Link im Panel und das Oeffnen
                                          // einer Session (src/vscode.mjs); null = kein Link
    pollSeconds, reorder: { ringDelta, cooldownSeconds, animateMs } },
  counts: { projects, satellites, sessions, agents, open,
    hookStatus,                            // Figuren, deren state per Hook gemeldet statt geraten ist
    prompt, working, waiting, dirty, unpushed, unassigned },
  planets: [ { id, label, theme,
    ground,                                // Bodenpalette der 3D-Ansicht (Kit-Skin), aus der Config;
                                            // fehlt der Schluessel, gilt theme === 'mars' ? 'rost' : 'gruen'
    station: { q, r, agents[] },
    hexes: [ { id, path, title,               // kein q/r mehr -- das Layout rechnet der Client (hexmap.mjs)
      parentId: '<id>' | null,              // unmittelbarer Elternordner, sonst null (Wurzel)
      origin: 'session' | 'discovered',     // eigene Session, oder unter einem bestehenden Feld gefunden
      satellites,                           // nur am Container: Zahl der Kinder
      satellitesCapped: <n> | null,         // gesetzt, wenn der Deckel maxSatellites gegriffen hat
      state: 'active|quiet|stale' | null,   // Fläche: letzte Agenten-Aktivität, null = nie ein Agent hier
      gitState: 'dirty|unpushed|clean|norepo|missing',  // Rand
      sessions: { total, fresh }, subagents, daysSinceActivity,
      branch, dirty, ahead, hasUpstream, commits7d,
      commitsByDay: [n x14] | null,       // Commits je Kalendertag (Committer-Datum), null ohne Repo
      isRepo, exists, members[],            // members = zusammengelegte Verzeichnisse
      dirs[],                               // kodierte Namen unter ~/.claude/projects
      note: { title, obsidianUri } | null,
      agents: [ { key, parentKey, sessionId, gitBranch, sub,
        dir,                                // Projektverzeichnis des Transkripts = Zuordnungsschlüssel
        cwd, cwds[],                        // aktuelle cwd; alle des Tails, neueste zuerst
        name, agentType, task, spawnDepth,  // aus subagents/*.meta.json, oft null
        open,                                   // Prozess-Registry: true/false, null = nicht lesbar
        state: 'working|prompt|waiting|idle',  // prompt = tool_use ohne tool_result (Heuristik)
                                                // oder offener interaktiver Tool-Aufruf
                                                // (AskUserQuestion, ExitPlanMode) -- dafuer feuert
                                                // kein Hook-Ereignis (Fix 2026-09-13), gilt
                                                // UNABHAENGIG vom gemeldeten Hook-Status und wird
                                                // zuerst geprueft (Fix-Runde 1, 2026-09-13: sonst
                                                // verschluckt der Zeitvergleich unten eine neue
                                                // Frage nach einer schon beantworteten Abfrage)
                                                // oder Hook-Status 'prompt' (PermissionRequest /
                                                // Notification permission_prompt), solange der
                                                // offene Aufruf nicht juenger ist als die Abfrage
                                                // selbst (Zeitstempel-Vergleich, 2s Toleranz,
                                                // korrigiert 2026-09-13 -- "kein offener Aufruf"
                                                // war als Kriterium falsch, siehe Fallen unten)
        statusSource: 'hook' | 'transcript',    // hook = von der Session selbst gemeldet, sonst geraten
        liveSubagents: <n> | null,              // Hook-Markerzaehler, nur Hauptsessions, sonst null
        pending: { tool, minutes } | null,     // Rohbefund, auch unter der Schwelle
        ageMinutes } ] } ] } ] }
```
