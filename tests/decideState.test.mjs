import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideState, parseMs } from '../src/sources/sessions.mjs';

const thresholds = { agentWorkingMinutes: 3, agentPromptMinutes: 1, agentWaitingMinutes: 90 };

// Kurzform mit sinnvollen Vorgaben, damit jeder Testfall nur die Felder
// nennen muss, die fuer ihn wirklich zaehlen.
function decide(over = {}) {
  return decideState({
    hookStatus: null,
    open: false,
    openTool: null,
    openSinceMs: null,
    hookSinceMs: null,
    pendingMin: null,
    ageMin: 0,
    recType: 'assistant',
    isOpen: true,
    sub: false,
    thresholds,
    ...over,
  });
}

test('tote Session schlaegt alles, auch einen Hook-Eintrag', () => {
  const r = decide({ isOpen: false, hookStatus: 'working', ageMin: 0 });
  assert.deepEqual(r, { state: 'idle', statusSource: 'transcript' });
});

test('Subagent bekommt nie den Hook, auch wenn isOpen true ist', () => {
  const r = decide({ isOpen: true, sub: true, hookStatus: 'working', ageMin: 0 });
  // Heuristik uebernimmt: ageMin 0 <= agentWorkingMinutes -> working, aber
  // ueber die Transkript-Schiene, nicht den Hook.
  assert.deepEqual(r, { state: 'working', statusSource: 'transcript' });
});

test('isOpen === null (Registry nicht lesbar) faellt auf die Heuristik zurueck', () => {
  const r = decide({ isOpen: null, hookStatus: 'working', ageMin: 0 });
  assert.equal(r.statusSource, 'transcript', 'Hook gilt nur bei isOpen === true, nicht bei null');
});

test('Hook working wird uebernommen', () => {
  const r = decide({ isOpen: true, hookStatus: 'working' });
  assert.deepEqual(r, { state: 'working', statusSource: 'hook' });
});

test('Hook waiting wird uebernommen', () => {
  const r = decide({ isOpen: true, hookStatus: 'waiting' });
  assert.deepEqual(r, { state: 'waiting', statusSource: 'hook' });
});

test('Hook idle wird uebernommen', () => {
  const r = decide({ isOpen: true, hookStatus: 'idle' });
  assert.deepEqual(r, { state: 'idle', statusSource: 'hook' });
});

// Korrigiert am 2026-09-13 (Stop -> waiting statt idle): R3 bleibt gueltig
// auch fuer den neuen Hook-Wert -- ein Subagent bekommt weiterhin nie den
// Hook, seine sessionId zeigt auf den Parent.
test('Hook waiting an einem Subagenten wird ignoriert, Heuristik entscheidet', () => {
  const r = decide({ isOpen: true, sub: true, hookStatus: 'waiting', ageMin: 0 });
  assert.deepEqual(r, { state: 'working', statusSource: 'transcript' });
});

// R24, korrigiert am 2026-09-13: der Zeitvergleich ersetzt "kein offener
// Aufruf" als Kriterium fuer die fallende Flanke -- siehe decideState fuer
// die Begruendung (Befund an Session 4fd42af6).
const HOOK_SINCE = Date.parse('2026-09-13T09:01:53.729Z');

// Fall 1: der offene Aufruf ist AELTER als die Abfrage -- das ist derselbe
// Aufruf, auf den sich die Abfrage bezieht, sie steht also noch offen.
test('Hook prompt mit Aufruf aelter als hookSince bleibt prompt (Abfrage noch offen)', () => {
  const r = decide({
    isOpen: true,
    hookStatus: 'prompt',
    open: true,
    pendingMin: 5,
    openSinceMs: HOOK_SINCE - 500,
    hookSinceMs: HOOK_SINCE,
  });
  assert.deepEqual(r, { state: 'prompt', statusSource: 'hook' });
});

// Fall 2 (Gegenprobe, bleibt der eigentliche Fix 2): der offene Aufruf ist
// JUENGER als die Abfrage plus Toleranz und kein interaktives Tool -- ein
// echter Folgeaufruf nach erteilter Erlaubnis (Befund: 50 Minuten 10 Sekunden
// spaeter, siehe docs/HISTORIE.md).
test('Hook prompt mit juengerem Bash-Aufruf faellt auf working (Gegenprobe zu Fix 2)', () => {
  const r = decide({
    isOpen: true,
    hookStatus: 'prompt',
    open: true,
    openTool: 'Bash',
    pendingMin: 0,
    openSinceMs: HOOK_SINCE + 50 * 60000 + 10000,
    hookSinceMs: HOOK_SINCE,
  });
  assert.deepEqual(r, { state: 'working', statusSource: 'hook' });
});

// Fall 3: der offene Aufruf liegt NACH der Abfrage, aber innerhalb der
// Jitter-Toleranz (hookSinceMs < openSinceMs < hookSinceMs + 2000) -- genau
// der Grenzfall, den die Toleranz abdecken soll (Schreibreihenfolge
// zwischen tool_use und PermissionRequest), kein echter Folgeaufruf.
// Korrigiert in Fix-Runde 1 (Review, Minor): die vorherige Fassung hatte
// openSinceMs VOR hookSinceMs gesetzt (strukturell eine Wiederholung von
// Fall 1) und testete den eigentlichen Grenzfall gar nicht.
test('Hook prompt mit Aufruf innerhalb der Jitter-Toleranz nach hookSince bleibt prompt', () => {
  const r = decide({
    isOpen: true,
    hookStatus: 'prompt',
    open: true,
    openTool: 'Bash',
    pendingMin: 0,
    openSinceMs: HOOK_SINCE + 1500,
    hookSinceMs: HOOK_SINCE,
  });
  assert.deepEqual(r, { state: 'prompt', statusSource: 'hook' });
});

// Gegenstueck zu Fall 3: knapp JENSEITS der Toleranz -- working.
test('Hook prompt mit Aufruf knapp jenseits der Jitter-Toleranz faellt auf working', () => {
  const r = decide({
    isOpen: true,
    hookStatus: 'prompt',
    open: true,
    openTool: 'Bash',
    pendingMin: 0,
    openSinceMs: HOOK_SINCE + 2001,
    hookSinceMs: HOOK_SINCE,
  });
  assert.deepEqual(r, { state: 'working', statusSource: 'hook' });
});

// Fall 4 (bestehend): kein offener Aufruf -- die Abfrage kann nicht mehr
// offen sein, unabhaengig von den Zeitstempeln.
test('Hook prompt ohne offenen Tool-Aufruf faellt auf working (fallende Flanke aus dem Transkript)', () => {
  const r = decide({ isOpen: true, hookStatus: 'prompt', open: false });
  assert.deepEqual(r, { state: 'working', statusSource: 'hook' });
});

// Fall 5: hookSinceMs unbekannt (Statusdatei ohne lesbares `since`) -- der
// Zeitvergleich kann nicht stattfinden, das bisherige, unscharfe Verhalten
// bleibt: prompt bei offenem Aufruf. Ehrlich unscharf statt falsch scharf.
test('Hook prompt mit unlesbarem hookSinceMs bleibt bei offenem Aufruf prompt', () => {
  const r = decide({
    isOpen: true,
    hookStatus: 'prompt',
    open: true,
    pendingMin: 5,
    openSinceMs: HOOK_SINCE,
    hookSinceMs: null,
  });
  assert.deepEqual(r, { state: 'prompt', statusSource: 'hook' });
});

// Fall 6: openSinceMs unbekannt (kaputter oder fehlender tool_use-Zeitstempel)
// -- gleiche Begruendung wie Fall 5, aus der anderen Richtung.
test('Hook prompt mit unlesbarem openSinceMs bleibt bei offenem Aufruf prompt', () => {
  const r = decide({
    isOpen: true,
    hookStatus: 'prompt',
    open: true,
    pendingMin: 5,
    openSinceMs: null,
    hookSinceMs: HOOK_SINCE,
  });
  assert.deepEqual(r, { state: 'prompt', statusSource: 'hook' });
});

// Fix vom 2026-09-13: fuer AskUserQuestion/ExitPlanMode feuert kein Hook-
// Ereignis (kein PermissionRequest, keine Notification) -- der Hook meldet
// in der Zwischenzeit faelschlich working. Ein offener interaktiver
// Tool-Aufruf im Transkript ueberstimmt das, unabhaengig von der Minuten-
// schwelle (Regression an Session a71eff33 gefunden).
test('Hook working mit offenem AskUserQuestion wird zu prompt, auch bei pendingMin 0', () => {
  const r = decide({ hookStatus: 'working', open: true, openTool: 'AskUserQuestion', pendingMin: 0 });
  assert.deepEqual(r, { state: 'prompt', statusSource: 'hook' });
});

test('Hook working mit offenem ExitPlanMode (Plan-Freigabe) wird zu prompt', () => {
  const r = decide({ hookStatus: 'working', open: true, openTool: 'ExitPlanMode', pendingMin: 0 });
  assert.deepEqual(r, { state: 'prompt', statusSource: 'hook' });
});

// Regression-Sperre: ein offener Bash-Lauf ist Arbeit, keine Frage an den
// Menschen -- der neue Zweig darf ihn nicht mit erfassen.
test('Hook working mit offenem Bash bleibt working (keine Verwechslung mit einer Frage)', () => {
  const r = decide({ hookStatus: 'working', open: true, openTool: 'Bash', pendingMin: 5 });
  assert.deepEqual(r, { state: 'working', statusSource: 'hook' });
});

test('Hook working ohne offenen Aufruf bleibt working', () => {
  const r = decide({ hookStatus: 'working', open: false, openTool: null });
  assert.deepEqual(r, { state: 'working', statusSource: 'hook' });
});

// Hook prompt (Permission) UND ein offener interaktiver Aufruf: kein
// Widerspruch, bleibt bei prompt -- der INTERACTIVE_TOOLS-Zweig greift jetzt
// zuerst (Fix-Runde 1), unabhaengig davon, dass hookStatus schon 'prompt' ist.
test('Hook prompt mit offenem AskUserQuestion bleibt prompt', () => {
  const r = decide({ hookStatus: 'prompt', open: true, openTool: 'AskUserQuestion', pendingMin: 0 });
  assert.deepEqual(r, { state: 'prompt', statusSource: 'hook' });
});

// Critical-Fund aus dem Review (Fix-Runde 1), woertliche Reproduktion: Hook
// meldet noch `prompt` (Statusdatei nicht aktualisiert, weil "Erlaubnis
// erteilt" kein Ereignis hat), aber die Session stellt im selben Turn eine
// NEUE Frage -- deren `tool_use` liegt klar (hier: gut drei Minuten) nach
// `hookSinceMs`, also weit jenseits der 2-Sekunden-Toleranz. Vor der
// Reihenfolge-Korrektur haette der Zeitvergleich das faelschlich als
// "Folgeaufruf, also working" gelesen, obwohl der Mensch jetzt wirklich
// gefragt ist. Muss bei `prompt` bleiben.
test('Reviewer-Fund: Hook prompt + juengerer offener AskUserQuestion bleibt prompt (nicht working)', () => {
  const r = decide({
    hookStatus: 'prompt',
    open: true,
    openTool: 'AskUserQuestion',
    pendingMin: 0,
    hookSinceMs: Date.parse('2026-09-13T09:01:53.729Z'),
    openSinceMs: Date.parse('2026-09-13T09:05:00.000Z'),
  });
  assert.deepEqual(r, { state: 'prompt', statusSource: 'hook' });
});

test('Hook prompt ohne offenen Aufruf faellt weiterhin auf working (bestehende Flanke unveraendert)', () => {
  const r = decide({ hookStatus: 'prompt', open: false, openTool: null });
  assert.deepEqual(r, { state: 'working', statusSource: 'hook' });
});

// Ohne Hook bleibt die reine Heuristik unveraendert massgeblich: ein offener
// AskUserQuestion unter der Schwelle bleibt working, wie jeder andere Tool-
// Aufruf auch -- der neue Zweig lebt ausschliesslich im Hook-Pfad.
test('ohne Hook: offener AskUserQuestion unter der Schwelle bleibt working (Heuristik unveraendert)', () => {
  const r = decide({ hookStatus: null, open: true, openTool: 'AskUserQuestion', pendingMin: 0.2, ageMin: 1 });
  assert.deepEqual(r, { state: 'working', statusSource: 'transcript' });
});

// R3 bleibt gültig: eine Subagenten-Figur bekommt nie den Hook, auch nicht
// fuer den neuen Zweig -- der offene AskUserQuestion landet bei ihr in der
// reinen Heuristik.
test('Subagent mit offenem AskUserQuestion bleibt bei der Heuristik, nicht beim neuen Hook-Zweig', () => {
  const r = decide({
    isOpen: true,
    sub: true,
    hookStatus: 'working',
    open: true,
    openTool: 'AskUserQuestion',
    pendingMin: 2,
    ageMin: 1,
  });
  assert.deepEqual(r, { state: 'prompt', statusSource: 'transcript' });
});

test('kein Hook-Eintrag (null) faellt auf die Heuristik zurueck', () => {
  const r = decide({ isOpen: true, hookStatus: null, ageMin: 0 });
  assert.deepEqual(r, { state: 'working', statusSource: 'transcript' });
});

// Die folgenden Faelle bilden die heutige Heuristik ohne Hook ab -- das ist
// die Regression-Sperre fuer die Extraktion aus `loadAgents`.
test('Heuristik: offener Aufruf ueber der Schwelle -> prompt', () => {
  const r = decide({ open: true, pendingMin: 2, ageMin: 1 });
  assert.deepEqual(r, { state: 'prompt', statusSource: 'transcript' });
});

test('Heuristik: offener Aufruf unter der Schwelle -> working (Schwelle greift, kein prompt)', () => {
  const r = decide({ open: true, pendingMin: 0.2, ageMin: 1 });
  assert.deepEqual(r, { state: 'working', statusSource: 'transcript' });
});

test('Heuristik: jung genug -> working', () => {
  const r = decide({ ageMin: 2 });
  assert.deepEqual(r, { state: 'working', statusSource: 'transcript' });
});

test('Heuristik: aelter, innerhalb withinCap, letzter Record assistant -> waiting', () => {
  const r = decide({ ageMin: 10, isOpen: true });
  assert.deepEqual(r, { state: 'waiting', statusSource: 'transcript' });
});

test('Heuristik: withinCap nur ueber den Zeitdeckel (isOpen null), noch unter agentWaitingMinutes -> waiting', () => {
  const r = decide({ ageMin: 10, isOpen: null });
  assert.deepEqual(r, { state: 'waiting', statusSource: 'transcript' });
});

test('Heuristik: withinCap ueberschritten (isOpen null, ueber agentWaitingMinutes) -> idle', () => {
  const r = decide({ ageMin: 200, isOpen: null });
  assert.deepEqual(r, { state: 'idle', statusSource: 'transcript' });
});

test('Heuristik: letzter Record nicht assistant -> idle statt waiting', () => {
  const r = decide({ ageMin: 10, isOpen: true, recType: 'user' });
  assert.deepEqual(r, { state: 'idle', statusSource: 'transcript' });
});

// I5: eine lebende Session mit sehr altem juengsten Rollen-Record (der
// Altersfilter in loadAgents lässt sie ueberleben, siehe dort) darf trotzdem
// nicht gruen (working) werden -- nur die Alters-Schwelle davor entscheidet,
// nicht die Lebendigkeit allein.
test('I5: sehr alte, aber offene Session ohne Hook wird nicht faelschlich working (kein Gruen)', () => {
  const r = decide({ ageMin: 60 * 24 * 10, isOpen: true, recType: 'assistant' });
  assert.notEqual(r.state, 'working', 'zehn Tage alt darf nicht wie frische Arbeit aussehen');
  assert.deepEqual(r, { state: 'waiting', statusSource: 'transcript' });
});

// Waechter fuer den R24-Zeitvergleich: ein kaputter ISO-String darf nie
// werfen, nur `null` liefern -- ein unparsebarer `since`-Wert hat in Task 1
// beinahe die ganze Erhebung umgerissen.
test('parseMs: kaputter String wirft nicht, liefert null', () => {
  assert.equal(parseMs('garbage'), null);
});

test('parseMs: gueltiger ISO-String liefert die Millisekunden', () => {
  assert.equal(parseMs('2026-09-13T09:01:53.729Z'), Date.parse('2026-09-13T09:01:53.729Z'));
});

test('parseMs: null und undefined liefern null, kein Wurf', () => {
  assert.equal(parseMs(null), null);
  assert.equal(parseMs(undefined), null);
});
