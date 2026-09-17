import { readFile } from 'node:fs/promises';
import { encodePath } from './claudeProjects.mjs';
import { tailInfo } from './transcript.mjs';
import { scanProjects } from './scan.mjs';
import { loadLiveSessions } from './liveSessions.mjs';
import { loadHookStatus } from './hookStatus.mjs';

const MIN = 60000;

/** Zeitstempel-Parser mit Waechter: ein kaputter oder fehlender ISO-String
 *  bricht nichts, sondern liefert `null` -- ein unparsebarer `since`-Wert hat
 *  in Task 1 beinahe die ganze Erhebung umgerissen. `Date.parse('garbage')`
 *  liefert `NaN`, nie einen Wurf; der Waechter macht daraus die ehrliche
 *  Auskunft "nicht ermittelbar" statt eine `NaN`, die sich in Vergleichen
 *  lautlos wie ein gueltiger, aber falscher Zeitstempel verhaelt. */
export function parseMs(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Toleranz fuer den R24-Zeitvergleich (siehe decideState): der `tool_use`-
 *  Record wird vom Modell geschrieben, das `PermissionRequest`-Ereignis (und
 *  damit die Statusdatei) feuert erst danach. Gemessen an Session
 *  4fd42af6 (2026-09-13): `tool_use` 09:01:53.516Z, Hook-`since`
 *  09:01:53.729Z -- 213 ms Jitter fuer denselben, tatsaechlich zusammen-
 *  gehoerigen Aufruf. Ein echter Folgeaufruf nach erteilter Erlaubnis liegt
 *  Minuten dahinter (in derselben Session real 50 Minuten 10 Sekunden --
 *  der urspruengliche Aufruf wurde nach fast 50 Minuten beantwortet, danach
 *  lief ein voellig unabhaengiger Bash-Aufruf). 2000 ms ist großzuegig genug
 *  fuer die Schreibreihenfolge und schluckt keinen echten Folgeaufruf. */
const PROMPT_EDGE_TOLERANCE_MS = 2000;

/** Tools, deren Antwort eine Handlung des Menschen ist, keine des Hooks: fuer
 *  `AskUserQuestion` und die Plan-Freigabe (`ExitPlanMode`) feuert weder ein
 *  `PermissionRequest`- noch ein `Notification`-Ereignis -- der Hook kann
 *  diese Fragen schlicht nicht sehen und meldet in der Zwischenzeit weiter
 *  `working`. Ihr `tool_use` steht ohne `tool_result` im Transkript, solange
 *  die Frage offen ist -- genau das Signal, das die Heuristik ohnehin schon
 *  berechnet (`pendingToolUse` in transcript.mjs). Fund vom 2026-09-13 an
 *  Session a71eff33 (Details in docs/HISTORIE.md).
 *
 *  `EnterPlanMode` gehoert NICHT dazu: das startet nur den Planungsmodus,
 *  es wartet nicht auf eine Antwort des Menschen. */
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** Die Zustandsentscheidung als reine Funktion ihrer Eingabe -- herausgeloest
 *  aus `loadAgents`, damit die Rangfolge tabellarisch testbar ist
 *  (`tests/decideState.test.mjs`), ohne Transkript oder Registry anzufassen.
 *
 *  `hookStatus` ist bereits der fuer diese Figur gueltige Status-String (oder
 *  `null`) -- die Frage, ob der Hook fuer eine Figur ueberhaupt gilt (nur
 *  Hauptsessions, nur bei lebendem Prozess), entscheidet diese Funktion
 *  selbst ueber `isOpen`/`sub`, nicht der Aufrufer. Genau das macht "Subagent
 *  bekommt nie den Hook" tabellarisch pruefbar, statt es beim Aufrufer
 *  stillschweigend vorauszusetzen.
 *
 *  `openTool` ist der Name des offenen Tool-Aufrufs (oder `null`) -- kleinste
 *  Erweiterung neben dem schon vorhandenen `open`-Flag, noetig fuer den
 *  INTERACTIVE_TOOLS-Zweig unten.
 *
 *  `openSinceMs`/`hookSinceMs` sind geparste Zeitstempel (`parseMs`, `null`
 *  wenn unbekannt oder unparsebar) fuer den R24-Zeitvergleich: der Zeitpunkt
 *  des offenen `tool_use` gegen den Zeitpunkt der Hook-Meldung. */
export function decideState({
  hookStatus,
  open,
  openTool = null,
  openSinceMs = null,
  hookSinceMs = null,
  pendingMin,
  ageMin,
  recType,
  isOpen,
  sub,
  thresholds,
}) {
  const { agentWorkingMinutes, agentPromptMinutes, agentWaitingMinutes } = thresholds;

  // Prozess weg: niemand arbeitet, niemand wartet — egal was das Transkript
  // oder eine liegengebliebene Statusdatei sagt. Haerteste Aussage, schlaegt
  // alles, auch einen (falschen) Hook-Eintrag.
  if (isOpen === false) return { state: 'idle', statusSource: 'transcript' };

  // Der Hook ist die einzige Quelle, die nicht raet — nur gueltig, solange
  // der Prozess nachweislich lebt, und nur fuer Hauptsessions: rec.sessionId
  // zeigt bei einem Subagenten auf die Session des Parents, die Figur wuerde
  // sonst den Zustand ihres Parents erben statt eigenen.
  if (isOpen === true && !sub && hookStatus != null) {
    // Fix vom 2026-09-13, Reihenfolge korrigiert in Fix-Runde 1 (Review,
    // Critical): diese Pruefung steht bewusst VOR dem R24-Zeitvergleich
    // unten und ist unabhaengig vom gemeldeten `hookStatus` -- nicht nur
    // bei `working`. Grund: der Hook hat fuer "Erlaubnis erteilt" kein
    // Ereignis (siehe R24 unten), die Statusdatei bleibt nach einer
    // gewaehrten Permission-Abfrage also auf `prompt` stehen, bis das
    // naechste Hook-Ereignis eintrifft. Stellt die Session im selben Turn
    // eine neue `AskUserQuestion`/`ExitPlanMode`, waere deren `tool_use`
    // juenger als diese (veraltete) `prompt`-Meldung -- der Zeitvergleich
    // unten wuerde daraus faelschlich `working` machen, waehrend der Mensch
    // gerade wirklich gefragt ist (vom Reviewer gefunden: `hookStatus:
    // 'prompt'`, offener `AskUserQuestion` juenger als `hookSinceMs` +
    // Toleranz ergab faelschlich `working`). `AskUserQuestion`/`ExitPlanMode`
    // sind eindeutig, unabhaengig davon, was der Hook zuletzt gemeldet hat
    // (`working`, `prompt`, ...) -- ihr offener `tool_use` heisst immer
    // "wartet auf den Menschen". Keine Minutenschwelle, `agentPromptMinutes`
    // gilt nur fuer die reine Heuristik unten. Genau eine Bedingung, keine
    // Kaskade zurueck in die Heuristik (Projektregel "Zustandsuebergaenge
    // nur eine Stufe").
    if (open && INTERACTIVE_TOOLS.has(openTool)) {
      return { state: 'prompt', statusSource: 'hook' };
    }
    // R24, korrigiert am 2026-09-13: die fallende Flanke einer Permission-
    // Abfrage liefert der Hook nicht ("Erlaubnis erteilt" feuert kein eigenes
    // Ereignis). Das fruehere Kriterium "kein offener Tool-Aufruf" war
    // falsch: eine arbeitende Session hat fast immer einen offenen Aufruf --
    // das ist ihr Normalzustand, kein Signal fuer "Abfrage beantwortet".
    // Richtig ist der Zeitvergleich: der offene Aufruf ist derselbe, auf den
    // sich die Abfrage bezieht, genau dann, wenn sein `tool_use` VOR der
    // Abfrage geschrieben wurde (plus Jitter-Toleranz). Ein offener Aufruf,
    // der NACH der Abfrage begann, beweist, dass die Session laengst
    // weitergearbeitet hat. Befund an Session 4fd42af6 (2026-09-13): der
    // urspruengliche Aufruf, auf den sich die Abfrage bezog, wurde nach fast
    // 50 Minuten beantwortet, danach lief ein voellig unabhaengiger Bash-
    // Aufruf -- der Hook meldete waehrenddessen weiter `prompt`, ohne dass ein
    // Mensch gefragt war. Der `INTERACTIVE_TOOLS`-Zweig oben muss dieser
    // Pruefung vorausgehen, sonst verschluckt genau dieser Zeitvergleich eine
    // echte, neue Frage (siehe oben).
    //
    // Genau eine Bedingung, keine Kaskade zurueck in die Heuristik
    // (Projektregel "Zustandsuebergaenge nur eine Stufe"). Sind Open- oder
    // Hook-Zeitstempel unbekannt, bleibt das bisherige, unscharfe Verhalten:
    // `prompt` bei offenem Aufruf -- ehrlich unscharf statt falsch scharf.
    if (hookStatus === 'prompt') {
      const openIsNewer =
        openSinceMs != null && hookSinceMs != null && openSinceMs > hookSinceMs + PROMPT_EDGE_TOLERANCE_MS;
      if (!open || openIsNewer) return { state: 'working', statusSource: 'hook' };
      return { state: 'prompt', statusSource: 'hook' };
    }
    return { state: hookStatus, statusSource: 'hook' };
  }

  // Der Zeitdeckel agentWaitingMinutes ist ein Notbehelf fuer den Fall, dass
  // die Registry nichts weiss. Ist die Session nachweislich offen, wartet
  // die Frage so lange, bis jemand reagiert — auch nach Stunden.
  const withinCap = isOpen === true || ageMin <= agentWaitingMinutes;

  let state;
  // `prompt` schlaegt `working`: eine Permission-Abfrage in den ersten drei
  // Minuten darf nicht gruen leuchten.
  if (open && pendingMin >= agentPromptMinutes && withinCap) state = 'prompt';
  else if (ageMin <= agentWorkingMinutes) state = 'working';
  else if (withinCap && recType === 'assistant') state = 'waiting';
  else state = 'idle';
  return { state, statusSource: 'transcript' };
}

/** Neben jedem Subagenten-Transkript liegt ein winziger Sidecar:
 *  {"agentType","description","name","toolUseId","spawnDepth"}. Der ist die
 *  einzige Quelle fuer einen sprechenden Namen — im Transkript selbst steht
 *  nur der Prompt. Fehlt er, bleibt alles null: lieber "—" im Panel als ein
 *  aus dem Prompt geratener Name. */
async function readMeta(file) {
  try {
    return JSON.parse(await readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Aktuell laufende bzw. kuerzlich aktive Sessions als Agenten-Figuren. */
export async function loadAgents(cfg, scanned) {
  const {
    agentWorkingMinutes,
    agentWaitingMinutes,
    agentDropHours,
    agentPromptMinutes = 1,
  } = cfg.thresholds;
  const dropBefore = Date.now() - agentDropHours * 60 * MIN;

  // Welche Sessions nachweislich noch einen Prozess haben. null heisst: die
  // Registry ist nicht lesbar — dann entscheidet unten allein die Zeit.
  const live = await loadLiveSessions(cfg);

  // Was die Sessions selbst ueber sich sagen. null heisst: kein Hook
  // installiert — dann bleibt unten alles wie vorher.
  const hookStatus = await loadHookStatus(cfg);

  // Die Eintraege kommen normalerweise vom Aufrufer, damit sie sich mit
  // claudeProjects.mjs denselben Durchlauf teilen. Ohne Argument selbst
  // scannen, damit der Aufruf fuer sich allein benutzbar bleibt.
  const entries = scanned ?? (await scanProjects(cfg.claudeProjectsDir, cfg.ignoreDirs ?? []));

  /* Alter Kram fliegt vor dem Lesen raus — das ist der Filter, der aus
   * >1000 Dateien eine Handvoll macht. Vorfilter nach mtime, denn eine Datei
   * mit alter mtime kann keinen neuen Record haben; die Aussage selbst kommt
   * unten aus dem Record-Zeitstempel (siehe transcript.mjs). Subagenten unter
   * <sessionId>/subagents/ sind mitgemeint: bei parallelen Tasks sind genau
   * sie die Mehrheit der Figuren. Die zugehoerige Hauptsession steht in
   * `parentKey`, den der Scan aus dem Verzeichnisnamen mitbringt — im
   * Transkript eines Subagenten gibt es keine Parent-ID. */
  //
  // Offene Sessions ueberleben den Altersfilter: ein Fenster, das seit drei
  // Tagen auf mich wartet, wartet trotzdem. Vorab reicht der Dateiname; bei
  // Subagenten haengt der Prozess am Parent, dessen sessionId der
  // Verzeichnisname ist.
  const fresh = entries.filter(
    (e) => e.mtimeMs >= dropBefore || Boolean(live?.has(e.parentKey ?? e.name.replace(/\.jsonl$/, ''))),
  );

  // Die Transkript-Schwaenze parallel lesen: es sind eine Handvoll Dateien,
  // aber jede kostet einen Syscall-Umweg.
  const agents = (
    await Promise.all(
      fresh.map(async (e) => {
        const { path: full, name, parentKey } = e;
        const info = await tailInfo(e).catch(() => null);
        if (!info) return null;
        const rec = info.last;
        // Aktivitaet = juengster Rollen-Record. Ohne einen (Schwanz ohne
        // Rolle, siehe readRoleRecords) bleibt die mtime der Rueckfall — wie
        // bisher, betrifft zwei alte Test-Sessions. Was nach dem Lesen
        // aelter ist als das Fenster, faellt hier raus statt als idle zu
        // bleiben: der mtime-Vorfilter hat es nur nicht erkennen koennen.
        const lastMs = info.lastMs ?? e.mtimeMs;

        // rec.sessionId zeigt auch im Subagenten-Transkript auf die Session,
        // deren Prozess die Figur traegt — genau der Schluessel der Registry.
        // Vorgezogen (I5): der zweite, praezisere Altersfilter unten braucht
        // isOpen bereits, um dieselbe Ausnahme zu kennen, die der grobe
        // mtime-Vorfilter oben schon hat.
        const key = name.replace(/\.jsonl$/, '');
        const sessionId = rec?.sessionId ?? parentKey ?? key;
        const isOpen = live ? live.has(sessionId) : null;

        // I5: eine nachweislich offene Session ueberlebt den Altersfilter
        // auch dann, wenn ihr juengster Rollen-Record aelter als das Fenster
        // ist -- der grobe mtime-Vorfilter oben rettet sie schon (Zeile ~108),
        // dieser praezisere Filter kannte die Ausnahme bisher nicht. Fund:
        // eine Session lebt nachweislich, ihr Transkript
        // ist 8,66 MB mit heutiger mtime, aber die letzten Zeilen sind
        // Buchhaltung (mode, atis-latch, last-prompt) ohne Rollen-Record --
        // der juengste ROLLEN-Record ist zehn Tage alt und fiel hier raus,
        // bevor die Figur ueberhaupt beim Hook oder der Heuristik ankam.
        //
        // Die Rettung gilt nur fuer Hauptsessions (parentKey === null):
        // `isOpen` einer Subagenten-Figur ist die geliehene Lebendigkeit
        // ihres PARENTS (sessionId zeigt bei einem Subagenten auf den
        // Parent, siehe oben), nicht ihre eigene. Ohne die Einschraenkung
        // rettete eine lange laufende Hauptsession jede ihrer laengst
        // beendeten Subagenten-Figuren mit -- Fund: dieselbe Session
        // riss so 40 Subagenten-Figuren mit 15 Tage alten Transkripten aus
        // dem Filter, jede mit "idle 21706 min - offen" im Panel, obwohl die
        // Arbeit laengst beendet ist. Frische Subagenten einer laufenden
        // Session verlieren dadurch nichts -- die kommen ueber den
        // mtime-Vorfilter oben (Zeile ~107).
        if (lastMs < dropBefore && (isOpen !== true || parentKey !== null)) return null;
        const ageMin = (Date.now() - lastMs) / MIN;
        const sub = Boolean(parentKey) || Boolean(rec?.isSidechain);
        const meta = sub ? await readMeta(full) : null;

        // Alter des offenen Aufrufs ab seinem Zeitstempel, notfalls ab dem
        // juengsten Record — nie ab "jetzt", sonst waere der Schwellwert
        // wirkungslos.
        const open = info.open;
        const pendingMin = open
          ? (Date.now() - (Date.parse(open.since) || lastMs)) / MIN
          : null;
        // Fuer den R24-Zeitvergleich in decideState: der Zeitstempel des
        // offenen Aufrufs, mit Waechter geparst statt roh -- ein kaputter
        // `since`-String darf die Erhebung nicht umreissen.
        const openSinceMs = open ? parseMs(open.since) : null;

        // `cwd` bleibt die aktuelle, das ist die ehrliche Angabe fuer das
        // Panel; `cwds` sind alle des Tails, neueste zuerst.
        const cwds = info.cwds;

        // Was der Hook zu dieser Session sagt, roh nachgeschlagen -- welcher
        // Teil davon gilt (nur Hauptsessions, nur bei lebendem Prozess),
        // entscheidet `decideState` selbst. Fuer `liveSubagents` unten bleibt
        // die alte, gegatete Form noetig: eine Subagenten-Figur soll dort
        // `null` zeigen, nicht den Zaehler ihrer Hauptsession.
        const hook = isOpen === true && !sub ? hookStatus?.get(sessionId) : undefined;
        // Ebenfalls mit Waechter: `loadHookStatus` reicht `since` schon als
        // geprueften String oder `null` durch, aber der Parse selbst kann
        // trotzdem an einem unerwarteten Format scheitern.
        const hookSinceMs = hook ? parseMs(hook.since) : null;

        const { state, statusSource } = decideState({
          hookStatus: hook?.status ?? null,
          open: Boolean(open),
          openTool: open?.tool ?? null,
          openSinceMs,
          hookSinceMs,
          pendingMin,
          ageMin,
          recType: rec?.type ?? null,
          isOpen,
          sub,
          thresholds: { agentWorkingMinutes, agentPromptMinutes, agentWaitingMinutes },
        });

        return {
          // Dateiname, nicht rec.sessionId: in einem Subagenten-Transkript
          // steht dort die Session des Parents — als Schluessel waeren alle
          // Kinder einer Session nicht mehr auseinanderzuhalten.
          key,
          parentKey: parentKey ?? null,
          // Projektverzeichnis des Transkripts (kodierter Name). Bei
          // Subagenten das des Parents — sie liegen unter dessen Session.
          dir: e.dir,
          sessionId,
          // Aus der Prozess-Registry: true = Prozess lebt, false = weg,
          // null = Registry nicht lesbar. Nie aus dem Transkript geraten.
          open: isOpen,
          cwd: rec?.cwd ?? '',
          cwds,
          gitBranch: rec?.gitBranch ?? null,
          // Subagenten zaehlen nie als "wartet auf mich": geantwortet wird
          // ihnen von ihrem Parent, nicht von mir.
          sub,
          name: meta?.name ?? null,
          agentType: meta?.agentType ?? null,
          task: meta?.description ?? null,
          spawnDepth: meta?.spawnDepth ?? null,
          scratchpad: false,
          lastActivity: new Date(lastMs).toISOString(),
          ageMinutes: Math.round(ageMin),
          // Rohbefund, unabhaengig vom Schwellwert: auch ein working-Agent hat
          // fuer Sekunden einen offenen Aufruf, und bei einem idle-Agenten
          // erklaert der Eintrag, dass die Session mitten im Tool abgebrochen ist.
          pending: open ? { tool: open.tool, minutes: Math.round(pendingMin) } : null,
          // `prompt` bleibt fuer Subagenten erhalten: ihre Permission-Abfragen
          // landen genauso bei mir wie die der Hauptsession. Nur `waiting`
          // wird gekappt, weil das Ende ihres Turns der Parent beantwortet.
          // Auf dem Hook-Pfad ist diese Bedingung seit jeher (R3) strukturell
          // tot: `decideState` schliesst Subagenten vom Hook aus, `waiting`
          // kann fuer sie also nur aus der Transkript-Heuristik kommen. Sie
          // bleibt trotzdem hier, weil genau die Heuristik `waiting` liefern
          // kann (Ledger-Minor #10).
          state: sub && state === 'waiting' ? 'idle' : state,
          // Woher die Aussage kommt. Steht im Panel, damit sichtbar bleibt,
          // wann die Karte weiss und wann sie raet.
          statusSource,
          // Laufende Subagenten laut Hook-Markerverzeichnis. null heisst: der
          // Hook weiss nichts zu dieser Session (nicht installiert, Session
          // nicht offen) oder es ist eine Subagenten-Figur selbst — deren
          // Zaehler traegt ohnehin die Hauptsession.
          liveSubagents: hook ? hook.subagents : null,
        };
      }),
    )
  )
    .filter(Boolean)
    .sort((a, b) => a.ageMinutes - b.ageMinutes);

  return agents;
}

const under = (path, base) => path === base || path.startsWith(base + '/');

/** Subagenten arbeiten in /tmp/claude-<uid>/<encoded-parent>/<uuid>/scratchpad.
 *  Der encodierte Parent ist der einzige Hinweis auf das echte Projekt. Die
 *  Kodierung ist verlustbehaftet (team/websites und team-websites werden
 *  beide zu "-team-websites"), darum Prefix-Match statt Rueckuebersetzung. */
function resolveScratchpad(cwd, candidates) {
  const seg = cwd.split('/').find((s) => s.startsWith('-home-'));
  if (!seg) return null;
  return candidates.find(({ base }) => seg.startsWith(encodePath(base))) ?? null;
}

/** Agenten auf die Hexfelder verteilen.
 *
 *  Erster Schluessel ist das Projektverzeichnis des Transkripts: die Felder
 *  sind aus genau diesen Verzeichnissen gebaut, und Claude Code legt eine
 *  Session immer unter ihrem Start-cwd ab — egal, wohin sie spaeter per `cd`
 *  wandert. Gemessen stimmt das mit der cwd-Zuordnung in 18 von 20 Faellen
 *  ueberein; die zwei Abweichungen waren Sessions, die zum Nachsehen nach
 *  ~/.claude/projects gewechselt hatten und im Hangar landeten.
 *
 *  Rueckfall ueber die cwds fuer Transkripte, deren Verzeichnis kein Feld
 *  ist (aus einem Scratchpad heraus gestartete Sessions, ignorierte Pfade).
 *  Gematcht wird gegen den Hex-Pfad **und** gegen seine `members` — ein Agent
 *  in einem Worktree gehoert auf das Feld des Repos, nicht in den Hangar.
 *  Laengster Prefix gewinnt, damit ~/team/automation nicht von ~/team geschluckt wird.
 */
export function assignAgents(hexes, agents) {
  const byDir = new Map();
  for (const h of hexes) for (const d of h.dirs ?? []) byDir.set(d, { hex: h });

  const candidates = hexes
    .flatMap((h) => [h.path, ...h.members].map((base) => ({ base, hex: h })))
    .sort((a, b) => b.base.length - a.base.length);

  // Kinder je Feld, einmal je Aufruf — die Umhaengung unten fragt fuer jede
  // Figur nach den Nachkommen ihres Feldes.
  const kidsOf = new Map();
  for (const h of hexes) {
    if (!h.parentId) continue;
    if (!kidsOf.has(h.parentId)) kidsOf.set(h.parentId, []);
    kidsOf.get(h.parentId).push(h);
  }
  const descendants = (id) => {
    const out = [];
    const queue = [...(kidsOf.get(id) ?? [])];
    while (queue.length) {
      const k = queue.shift();
      out.push(k);
      queue.push(...(kidsOf.get(k.id) ?? []));
    }
    return out;
  };

  const unassigned = [];
  for (const a of agents) {
    // Neueste cwd zuerst; einmal gebaut, beide Zweige unten nutzen sie.
    const cwds = a.cwds?.length ? a.cwds : [a.cwd];
    let hit = byDir.get(a.dir) ?? null;
    /* Die Figur gehoert an den Hauptordner: dort ist die Session gestartet,
     * und dort liegt ihr Transkript. Wechselt sie aber wirklich in ein
     * Unter-Repo derselben Familie, soll sie mitwandern.
     *
     * Streng auf die Familie begrenzt, und das ist der Kern: waere es ein
     * freier cwd-Vergleich, kaeme die cd-Drift-Falle zurueck — ein `cd
     * ~/.claude/projects` zum Nachsehen klebt in der Bash-cwd und wuerde
     * Figuren verschieben. Ein Satellitenpfad liegt immer unter dem
     * Container, das kann ein Ausflug nicht treffen. Nachkommen statt nur
     * direkte Kinder: seit `parentId` den echten Elternordner meint, kann
     * die Familie mehr als zwei Ebenen haben, und die Figur soll bis ins
     * tiefste Unter-Repo folgen, in dem sie wirklich arbeitet. */
    if (hit && cwds[0]) {
      const sat = descendants(hit.hex.id)
        .filter((s) => under(cwds[0], s.path))
        .sort((x, y) => y.path.length - x.path.length)[0];
      if (sat) hit = { hex: sat };
    }
    // Rueckfall: die erste cwd, die auf ein Feld zeigt, gewinnt.
    for (let i = 0; !hit && i < cwds.length; i++) {
      const cwd = cwds[i];
      if (!cwd) continue;
      hit = candidates.find(({ base }) => under(cwd, base)) ?? null;
      if (!hit && cwd.includes('/scratchpad')) {
        hit = resolveScratchpad(cwd, candidates);
        if (hit) a.scratchpad = true;
      }
    }
    if (hit) hit.hex.agents.push(a);
    else unassigned.push(a);
  }
  return unassigned;
}
