/** Axiale Hex-Koordinaten als Spirale um den Ursprung.
 *  Ring 0 = Hangar in der Mitte, danach ringweise nach aussen. */
export const DIRS = [
  [1, 0], [1, -1], [0, -1],
  [-1, 0], [-1, 1], [0, 1],
];

export function spiral(count) {
  const out = [{ q: 0, r: 0 }];
  let ring = 1;
  while (out.length < count) {
    let q = -ring;
    let r = ring;
    for (const [dq, dr] of DIRS) {
      for (let i = 0; i < ring; i++) {
        out.push({ q, r });
        if (out.length >= count) return out;
        q += dq;
        r += dr;
      }
    }
    ring++;
  }
  return out.slice(0, count);
}

/** Innen liegt, was Aufmerksamkeit verdient.
 *
 *  Sortierung: Agenten mit offenem Tool-Aufruf zuerst, dann wartende, dann
 *  laufende, dann frische Sessions. Das Auge startet in der Mitte — dort soll
 *  stehen, wo gerade etwas haengt, nicht was alphabetisch vorne liegt. Ruinen
 *  wandern nach aussen. */
function weight(h) {
  // Der Collector setzt bei jedem entdeckten Satelliten `agents: []` und
  // `sessions: { total: 0, fresh: 0 }` — der Zugriff wirft hier also nie.
  // Die Vorsicht bleibt trotzdem stehen, weil sie nichts kostet und
  // handgebaute Objekte in Probes/Fixtures absichert, die diese Felder
  // weglassen.
  const agents = h.agents ?? [];
  const prompt = agents.filter((a) => a.state === 'prompt').length;
  const waiting = agents.filter((a) => a.state === 'waiting').length;
  const working = agents.filter((a) => a.state === 'working').length;
  return (
    (h.gitState === 'missing' ? -1000 : 0) +
    prompt * 120 +
    waiting * 100 +
    working * 60 +
    agents.length * 20 +
    (h.sessions?.fresh ?? 0)
  );
}

const cellKey = (c) => c.q + ',' + c.r;

/* Wie viele Waben ein Projekt belegt: 1 bis 5, gestuft nach dem Arbeits-
 * volumen, das darin steckt -- Sessions plus Subagenten, kumulativ ueber
 * alles, was unter ~/.claude/projects noch liegt.
 *
 * Warum dieses Mass und keins der naheliegenderen (Andrés Entscheidung vom
 * 2026-09-14, an echten Zahlen geprueft): Dateizahl im Repo streut von 7 bis
 * 60.603 und misst Vendor-Ordner statt Arbeit; die Commit-Historie fehlt bei
 * vier der aktivsten Felder ganz, weil sie keine Repos sind. Sessions gibt
 * es fuer jedes Feld, die Zahl waechst monoton und traege -- die Groesse
 * springt also nicht, und das Layout bleibt ruhig.
 *
 * Die Stufen sind grob geometrisch und bewusst hoch: fuenf Waben soll es
 * selten geben (heute erreicht sie niemand, zwei Projekte haetten vier).
 * Sie leben im Client, weil der State beide Zahlen ohnehin traegt -- keine
 * neue Quelle, kein neues Feld in /api/state. */
const SIZE_STEPS = [30, 90, 200, 400];
const MAX_CELLS = SIZE_STEPS.length + 1;

export function sizeOf(h) {
  const work = (h.sessions?.total ?? 0) + (h.subagents ?? 0);
  let n = 1;
  for (const step of SIZE_STEPS) if (work >= step) n++;
  return Math.min(n, MAX_CELLS);
}

/* Alle Zellen eines Feldes, auch fuer Objekte, die noch kein Layout gesehen
 * haben (Fixtures, Proben): dann ist es eben nur die Hauptzelle. */
export function cellsOf(h) {
  return h.cells ?? (Number.isFinite(h.q) ? [{ q: h.q, r: h.r }] : []);
}

/* Abstand einer Wabe vom Hangar in Hex-Schritten. Kinder bevorzugen den
 * Nachbarplatz mit dem groesseren Abstand: Familien wachsen nach aussen und
 * druecken nicht in die Mitte, wo die Aufmerksamkeit hingehoert. */
const ringDist = (c) => (Math.abs(c.q) + Math.abs(c.r) + Math.abs(c.q + c.r)) / 2;

const neighbours = (c) => DIRS.map(([dq, dr]) => ({ q: c.q + dq, r: c.r + dr }));

export function childrenOf(hexes, id) {
  return hexes.filter((h) => h.parentId === id);
}

/* Ein Index je Layout-Lauf: Feld nach ID und Kinder je Parent. Das ist das
 * `childIndex` der Spec, um `byId` erweitert, weil `rootOf` beides braucht.
 * Das Layout, die Silhouette, der Chip und das Rollup fragen sonst je Feld
 * und je Bild die ganze Liste ab — bei 21 Feldern 441 Vergleiche je Frame,
 * bei 60 Frames. */
export function index(hexes) {
  const byId = new Map(hexes.map((h) => [h.id, h]));
  const kidsOf = new Map();
  for (const h of hexes) {
    if (!h.parentId || !byId.has(h.parentId)) continue;
    if (!kidsOf.has(h.parentId)) kidsOf.set(h.parentId, []);
    kidsOf.get(h.parentId).push(h);
  }
  return { byId, kidsOf };
}

/* Die Wurzel einer Familie: dem `parentId` folgen, bis keiner mehr da ist.
 * Ein Parent, den es im Array nicht gibt (anderer Planet), zaehlt als keiner —
 * das Feld ist dann seine eigene Wurzel, statt ohne Koordinaten zu bleiben. */
export function rootOf(h, idx) {
  let p = h;
  while (p.parentId && idx.byId.has(p.parentId)) p = idx.byId.get(p.parentId);
  return p;
}

/* Alle Nachkommen, Breitensuche. Seit `parentId` den echten Elternordner
 * meint, kann eine Familie mehr als zwei Ebenen haben — alles, was eine
 * Familie als Ganzes behandelt (Zuklappen, Aggregation, Rollup, Chip-Zahl),
 * arbeitet mit dieser Liste, nicht mit den direkten Kindern. */
export function descendantsOf(id, idx) {
  const out = [];
  const queue = [...(idx.kidsOf.get(id) ?? [])];
  while (queue.length) {
    const k = queue.shift();
    out.push(k);
    queue.push(...(idx.kidsOf.get(k.id) ?? []));
  }
  return out;
}

/* Der naechste Vorfahre, den man sieht — bei einem versteckten Feld also der
 * zugeklappte Container, der es auf der Karte vertritt. Fuer ein sichtbares
 * Feld es selbst. Setzt voraus, dass `hidden` schon steht. */
function visibleAncestor(h, idx) {
  let p = h;
  while (p.hidden && p.parentId && idx.byId.has(p.parentId)) p = idx.byId.get(p.parentId);
  return p;
}

/* Versteckt ist, wer irgendeinen echten Vorfahren in `collapsed` hat. */
export function hiddenBy(h, idx, collapsed) {
  let p = h;
  while (p.parentId && idx.byId.has(p.parentId)) {
    if (collapsed.has(p.parentId)) return true;
    p = idx.byId.get(p.parentId);
  }
  return false;
}

/* Zugeklappt muss der Container den Git-Zustand seiner Kinder aufnehmen —
 * sonst versteckt das Zuklappen genau das, wofuer es die Satelliten gibt.
 * Aufgeklappt aggregiert er nichts: deployments ist wirklich kein Repo, und
 * seine Kinder stehen daneben. Prioritaet wie in git.mjs: dirty > unpushed. */
export function aggregateGit(parent, children) {
  if (children.some((c) => c.gitState === 'dirty')) return 'dirty';
  if (children.some((c) => c.gitState === 'unpushed')) return 'unpushed';
  return parent.gitState;
}

/* Familien in Aufmerksamkeits-Reihenfolge auf die Spirale legen.
 *
 * Der Parent bekommt nicht einfach den naechsten freien Platz, sondern den
 * naechsten, an dem seine Kinder auch danebenpassen. Ohne diese Bedingung
 * zerfasert eine grosse Familie, sobald sie spaet dran ist: deployments hat
 * wenig Gewicht, kam zuletzt, und seine sieben Kinder verteilten sich im
 * Mockup ueber die halbe Karte.
 *
 * Belegt bleibt belegt — deshalb kann sich nichts ueberschneiden, und neue
 * Projekte haengen sich weiter hinten an die Spirale.
 *
 * Bewusst mutierend, nicht kopierend: setzt `q`/`r` (und `hidden`) direkt auf
 * den uebergebenen Hex-Objekten und gibt dasselbe Array zurueck. `view.mjs`,
 * `map.mjs` und `skyline.mjs` lesen `h.q`/`h.r` danach direkt von genau
 * diesen Objekten — eine Kopie zurueckzugeben hiesse, den State an drei
 * Stellen umzuhaengen. Der Nebeneffekt ist load-bearing: `app.selected`
 * bleibt ueber einen Layout-Lauf hinweg dieselbe Objektreferenz und damit
 * gueltig, ohne dass irgendwer sie nachziehen muesste. Familie heisst hier:
 * eine Wurzel (Feld ohne Parent) und alle ihre Nachkommen, egal wie tief —
 * versteckte eingeschlossen (seit 2026-09-14).
 *
 * Ein zugeklapptes Kind setzt sich auf die Zelle des Containers, der es auf
 * der Karte vertritt, und belegt selbst nichts (seit 2026-09-15). Es hat
 * damit endliche q/r — das war der Grund der Regel davor: versteckte Felder
 * ohne Koordinaten machten in der 3D-Ansicht, die mit allen Feldern rechnet
 * (world.mjs::boundsOf(all), ground.mjs), NaN, und Schattenkegel wie Felsen
 * verschwanden bis zum Aufklappen. Seine eigene Zelle zu reservieren war
 * dafuer aber nie noetig, und es kostete genau das, wofuer man zuklappt:
 * eine zugeklappte Familie hielt weiter die halbe Nachbarschaft besetzt, die
 * Karte zerfiel in Inseln, und "ordnen" konnte daran nichts aendern, weil
 * das Ergebnis mit denselben belegten Zellen dasselbe blieb (Andrés Befund
 * vom 2026-09-15). Preis: Aufklappen sucht die Plaetze neu, ein Nachbar kann
 * sich inzwischen dort niedergelassen haben — dann weicht das Kind per
 * Breitensuche in die zweite Schale aus.
 *
 * Mit Ankern (drittes Argument) behalten Familien ihren Platz — siehe
 * anchors.mjs. Ohne Anker ist das Ergebnis identisch mit dem bisherigen:
 * Gewichtsreihenfolge, greedy. */
export function layout(hexes, collapsed = new Set(), anchors = new Map()) {
  const idx = index(hexes);
  for (const h of hexes) h.hidden = hiddenBy(h, idx, collapsed);

  const families = hexes
    .filter((h) => rootOf(h, idx) === h)
    .map((root) => {
      const kids = descendantsOf(root.id, idx);
      return { parent: root, kids, w: Math.max(weight(root), ...kids.map(weight)) };
    })
    .sort((a, b) => b.w - a.w);

  const used = new Set(['0,0']); // Ring 0 gehoert dem Hangar
  const cells = spiral(hexes.length * MAX_CELLS * 7 + 49);
  const freeNb = (c) => neighbours(c).filter((n) => !used.has(cellKey(n)));

  /* Durchgang 1: verankerte Familien setzen sich auf ihren gemerkten Platz,
   * wenn er frei ist — ohne die Bedingung "Kinder passen daneben".
   * Stabilitaet schlaegt Kompaktheit; Kinder, die nicht mehr danebenpassen,
   * weichen unten per Breitensuche aus, und Silhouette plus Bruecken zeigen
   * die Zugehoerigkeit auch ueber einen Zellenabstand. Ist der Platz belegt
   * (zwei Familien erinnern sich an dieselbe Zelle), faellt die Familie in
   * Durchgang 2; da die Familien nach Gewicht sortiert sind, gewinnt bei
   * Konflikten das hoehere. */
  const pending = [];
  for (const f of families) {
    const a = anchors.get(f.parent.id);
    if (a && !used.has(cellKey(a))) {
      used.add(cellKey(a));
      f.parent.q = a.q;
      f.parent.r = a.r;
    } else {
      pending.push(f);
    }
  }

  /* Durchgang 2: neue Familien — ohne gemerkten Platz — bekommen wie bisher
   * den ersten freien Spiralplatz, an dem ihre Kinder auch danebenpassen.
   * Ohne diese Bedingung zerfasert eine grosse Familie, sobald sie spaet
   * dran ist (deployments im Mockup). */
  for (const f of pending) {
    // Nur die sichtbaren Kinder brauchen einen Nachbarplatz: eine zugeklappte
    // Familie ist so breit wie ihr Container, nicht wie ihre Sippe.
    const need = Math.min(f.kids.filter((k) => !k.hidden).length, 6);
    const p = cells.find((c, i) => i > 0 && !used.has(cellKey(c)) && freeNb(c).length >= need);
    used.add(cellKey(p));
    f.parent.q = p.q;
    f.parent.r = p.r;
  }

  /* Durchgang 3: Kinder um ihre Wurzel. Ab dem siebten Kind — oder wenn die
   * Nachbarn einer verankerten Wurzel inzwischen belegt sind — liefert die
   * Breitensuche den naechsten freien Platz in zweiter Schale. */
  for (const f of families) {
    const p = { q: f.parent.q, r: f.parent.r };
    for (const kid of f.kids) {
      /* Zugeklappt: auf die Zelle des vertretenden Containers, ohne sie zu
       * belegen — sie gehoert ihm ja schon. `descendantsOf` liefert
       * Breitensuche, der Vorfahr steht also bereits. */
      if (kid.hidden) {
        const a = visibleAncestor(kid, idx);
        kid.q = a.q;
        kid.r = a.r;
        continue;
      }
      let cell = freeNb(p).sort((a, b) => ringDist(b) - ringDist(a))[0];
      if (!cell) {
        const seen = new Set([cellKey(p)]);
        const queue = [p];
        while (queue.length && !cell) {
          for (const n of neighbours(queue.shift())) {
            if (seen.has(cellKey(n))) continue;
            seen.add(cellKey(n));
            queue.push(n);
            if (!used.has(cellKey(n))) { cell = n; break; }
          }
        }
      }
      used.add(cellKey(cell));
      kid.q = cell.q;
      kid.r = cell.r;
    }
  }

  /* Durchgang 4: Zusatzwaben. Ein Projekt belegt sizeOf(h) Zellen; die
   * Hauptzelle steht schon, die weiteren wachsen an der eigenen Flaeche.
   * Erst nach Durchgang 3, damit kein grosses Projekt einem Kind seinen
   * Platz neben dem Parent wegnimmt -- Familie schlaegt Groesse.
   *
   * Die Reihenfolge ist absteigend nach Groesse: wer viele Zellen braucht,
   * sucht zuerst. Unter den freien Nachbarn gewinnt die Zelle, die schon an
   * den meisten eigenen anliegt (kompakter Klumpen statt Schlange) und bei
   * Gleichstand die weiter aussen liegende -- die Kolonie waechst nach
   * aussen, die Mitte bleibt fuer die Aufmerksamkeit frei.
   *
   * Findet sich keine freie Nachbarzelle mehr, bleibt das Projekt kleiner
   * als seine Stufe. Das ist ehrlicher als ein Cluster, der ueber die halbe
   * Karte zerfasert. */
  // Versteckte teilen sich die Zelle ihres Containers und wachsen nicht:
  // eine zugeklappte Familie zeigt genau eine Flaeche, die des Containers.
  for (const h of hexes) if (h.hidden && Number.isFinite(h.q)) h.cells = [{ q: h.q, r: h.r }];
  const bySize = hexes.filter((h) => !h.hidden && Number.isFinite(h.q)).sort((a, b) => sizeOf(b) - sizeOf(a));
  for (const h of bySize) {
    h.cells = [{ q: h.q, r: h.r }];
    const want = sizeOf(h);
    const mine = new Set([cellKey(h)]);
    while (h.cells.length < want) {
      const seen = new Set();
      const cand = [];
      for (const c of h.cells) {
        for (const n of neighbours(c)) {
          const k = cellKey(n);
          if (used.has(k) || seen.has(k)) continue;
          seen.add(k);
          cand.push({ ...n, adj: neighbours(n).filter((x) => mine.has(cellKey(x))).length });
        }
      }
      if (!cand.length) break;
      cand.sort((a, b) => b.adj - a.adj || ringDist(b) - ringDist(a));
      const pick = { q: cand[0].q, r: cand[0].r };
      used.add(cellKey(pick));
      mine.add(cellKey(pick));
      h.cells.push(pick);
    }
  }
  return hexes;
}

/* Abstand einer Zelle vom Hangar in Ringen — nach aussen sichtbar, weil die
 * Umordnungsentscheidung damit rechnet. */
export const ringOf = (c) => ringDist(c);

/* Ein Layout auf Kopien: dieselbe Rechnung, kein Nebeneffekt auf den
 * uebergebenen Feldern. Flache Kopien reichen — `layout` schreibt nur q, r,
 * hidden und cells. `cells` steht mit dabei (seit 2026-09-15): ein Projekt
 * kann mehrere Waben belegen, und wer die Zellen eines Trockenlaufs braucht
 * (ground.mjs::expandedSpots, world.mjs::boundsOf), muss sie sonst selbst neu
 * herleiten. */
export function dryLayout(hexes, collapsed = new Set(), anchors = new Map()) {
  const copies = hexes.map((h) => ({ ...h }));
  layout(copies, collapsed, anchors);
  return new Map(copies.map((c) => [c.id, { q: c.q, r: c.r, hidden: c.hidden, cells: c.cells }]));
}

/* Wuerde ein Druck auf "ordnen" ueberhaupt etwas bewegen?
 *
 * Anders als `reorderNeeded` zaehlt hier jede Abweichung, nicht erst ein
 * Ringabstand: der Knopf soll genau dann etwas zu tun haben, wenn sich
 * danach auch etwas bewegt. Ohne diese Auskunft ist "nichts umzuordnen"
 * nicht von "kaputt" zu unterscheiden — genau das war Andrés Befund vom
 * 2026-09-15: die Karte lag nach dem ersten Druck im Gewichts-Optimum, jeder
 * weitere rechnete dasselbe Layout aus, und der Knopf blieb stumm. */
export function reorderWouldMove(hexes, collapsed) {
  const ideal = dryLayout(hexes, collapsed);
  return hexes.some((h) => {
    if (h.hidden || !Number.isFinite(h.q)) return false;
    const want = ideal.get(h.id);
    return Boolean(want) && (h.q !== want.q || h.r !== want.r);
  });
}

/* Liegt irgendeine Wurzel um `ringDelta` Ringe oder mehr woanders, als sie
 * nach Gewicht laege? Verglichen wird das aktuelle (verankerte) Layout mit
 * einem Trockenlauf OHNE Anker. Nur Wurzeln zaehlen: Kinder folgen ihrer
 * Wurzel, ihr Ring ist keine eigene Aussage. */
export function reorderNeeded(hexes, collapsed, ringDelta) {
  const idx = index(hexes);
  const ideal = dryLayout(hexes, collapsed);
  for (const h of hexes) {
    if (h.hidden || rootOf(h, idx) !== h) continue;
    const want = ideal.get(h.id);
    if (!want || !Number.isFinite(h.q)) continue;
    if (Math.abs(ringOf(h) - ringOf(want)) >= ringDelta) return true;
  }
  return false;
}
