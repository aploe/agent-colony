// Permission requests that Claude Code's PermissionRequest hook hands to the server, held until
// the user answers them in the panel. Port of Agent Tower's requests.mjs, requestDetail /
// requestQuestions of its steps.mjs, and the hook/answer handlers of its app.mjs.
//
// This file is the second outward channel next to POST /api/open-session. The server never
// decides anything by itself: a decision exists only as the answer to one held request, built
// here from what the user clicked. Everything testable lives in createAnswering(); server.mjs
// only wires it.
import { randomUUID } from 'node:crypto';
import { UUID } from './vscode.mjs';

export const MAX_HELD = 50;
/** How long a new request may wait for its session to show up as asking before it counts as
 *  answered elsewhere: the hook call arrives a moment before the registry says "waiting". */
export const GRACE_MS = 3000;
export const MAX_DETAIL = 4000;
export const MAX_HOOK_BODY = 1024 * 1024;
export const MAX_ANSWER_BODY = 4096;

/** What the deny button sends. `interrupt` makes it behave like "No" in the VS Code dialog: the
 *  session stops and waits. Claude Code then shows its own rejection text; the message is kept
 *  for versions that show it. */
export const DENY = { behavior: 'deny', message: 'Denied by the user in Agent Colony.', interrupt: true };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
const no = (why) => ({ hold: false, why });

// ---------- what the panel shows above its answer buttons ----------
// Nothing here is shortened: a request whose text does not fit is not offered for answering
// at all (null).

/** The field that names what a tool is about to do, and whether its other inputs are listed. */
const DETAIL_FIELD = {
  Bash: { main: 'command', listOthers: true, skip: ['description'] },
  WebFetch: { main: 'url', listOthers: true, skip: [] },
  Write: { main: 'file_path', listOthers: false },
  Edit: { main: 'file_path', listOthers: false },
  NotebookEdit: { main: 'file_path', listOthers: false },
};

/**
 * { detail, extras } for a permission request, or null when it cannot be shown in full.
 * extras lists the call's other inputs as "key: <JSON>" lines: a call can need permission
 * because of one of them (leaving the sandbox), so they must be visible. File tools show the
 * path only; their content fields are left out on purpose.
 */
export function requestDetail(tool, input) {
  if (!isObj(input)) return null;
  const spec = DETAIL_FIELD[tool];
  let detail;
  let extras = [];
  if (spec) {
    detail = str(input[spec.main]);
    if (detail === null) return null;
    if (spec.listOthers) {
      extras = Object.keys(input)
        .filter((key) => key !== spec.main && !spec.skip.includes(key))
        .map((key) => `${key}: ${JSON.stringify(input[key])}`);
    }
  } else {
    try {
      detail = JSON.stringify(input);
    } catch {
      return null;
    }
  }
  const length = extras.reduce((sum, line) => sum + line.length, detail.length);
  return length > MAX_DETAIL ? null : { detail, extras };
}

/**
 * The questions of an AskUserQuestion request in the shape the panel answers by index, or
 * null when that is not possible: 1 to 4 questions, each with at least two options that carry
 * a label, question texts unique (the answer is keyed by them), labels unique per question.
 */
export function requestQuestions(input) {
  if (!isObj(input) || !Array.isArray(input.questions)) return null;
  if (input.questions.length < 1 || input.questions.length > 4) return null;
  const out = [];
  const texts = new Set();
  for (const q of input.questions) {
    if (!isObj(q) || typeof q.question !== 'string' || texts.has(q.question)) return null;
    texts.add(q.question);
    if (!Array.isArray(q.options) || q.options.length < 2) return null;
    const labels = new Set();
    const options = [];
    for (const o of q.options) {
      if (!isObj(o) || typeof o.label !== 'string' || labels.has(o.label)) return null;
      labels.add(o.label);
      options.push({ label: o.label, description: typeof o.description === 'string' ? o.description : '' });
    }
    out.push({
      question: q.question,
      header: typeof q.header === 'string' ? q.header : '',
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return out;
}

// ---------- rules ----------

/** The main-agent rows of a state, keyed by session id. Subagents share their parent's session
 *  id and never own a dialog. */
export function sessionRows(state) {
  const rows = new Map();
  const take = (agents) => {
    for (const a of agents ?? []) if (!a.sub && typeof a.sessionId === 'string') rows.set(a.sessionId, a);
  };
  for (const planet of state?.planets ?? []) {
    for (const hex of planet.hexes ?? []) take(hex.agents);
    take(planet.station?.agents);
  }
  return rows;
}

/**
 * Whether a hook call is held for the panel. Everything that is not held gets "no decision"
 * at once and takes the path it takes without this tool.
 * session: the agent row with the payload's session id, or null.
 */
export function eligibility({ payload, session, enabled, heldCount }) {
  if (!enabled) return no('off');
  if (!isObj(payload) || payload.hook_event_name !== 'PermissionRequest' || typeof payload.session_id !== 'string'
    || !UUID.test(payload.session_id) || typeof payload.tool_name !== 'string' || !isObj(payload.tool_input)) {
    return no('payload');
  }
  // Only sessions that show their own dialog next to the panel: VS Code with a live process.
  if (!session || session.open !== true || session.entrypoint !== 'claude-vscode') return no('session');
  const tool = payload.tool_name;
  if (tool === 'ExitPlanMode') return no('plan');

  const agentId = typeof payload.agent_id === 'string' && payload.agent_id ? payload.agent_id : null;
  const base = { sessionId: payload.session_id, agentId, via: agentId ? 'subagent' : 'main', tool };
  let request;
  if (tool === 'AskUserQuestion') {
    const questions = requestQuestions(payload.tool_input);
    if (!questions) return no('questions');
    request = { ...base, kind: 'question', detail: null, extras: [], questions, toolInput: payload.tool_input };
  } else {
    const shown = requestDetail(tool, payload.tool_input);
    if (!shown) return no('detail');
    request = { ...base, kind: 'permission', detail: shown.detail, extras: shown.extras, questions: null, toolInput: null };
  }
  if (heldCount >= MAX_HELD) return no('full');
  return { hold: true, request };
}

const refuse = (reason) => ({ ok: false, reason });

/** One entry of `choices` against its question: indices in range, no duplicates, exactly one
 *  for a single choice and at least one for a multiple choice. */
function validChoice(question, picked) {
  if (!Array.isArray(picked) || picked.length === 0) return false;
  if (!question.multiSelect && picked.length !== 1) return false;
  if (new Set(picked).size !== picked.length) return false;
  return picked.every((i) => Number.isInteger(i) && i >= 0 && i < question.options.length);
}

/**
 * The decision for a held request from the page's answer { behavior, choices }.
 * A question is answered with its own option labels, picked by index: the page never sends
 * answer text. Refusals here only meet a broken or foreign request, so they stay English.
 */
export function decisionFor(request, body) {
  const behavior = isObj(body) ? body.behavior : undefined;
  if (request.kind === 'question') {
    if (behavior !== 'allow') return refuse('A question can only be answered here');
    const { questions } = request;
    const choices = body.choices;
    if (!Array.isArray(choices) || choices.length !== questions.length
      || !questions.every((q, k) => validChoice(q, choices[k]))) {
      return refuse('Choices incomplete or invalid');
    }
    const answers = {};
    questions.forEach((q, k) => {
      const picked = new Set(choices[k]);
      // Option order, joined the way VS Code records a multiple choice.
      answers[q.question] = q.options.filter((_, i) => picked.has(i)).map((o) => o.label).join(', ');
    });
    return { ok: true, decision: { behavior: 'allow', updatedInput: { ...request.toolInput, answers } } };
  }
  if (behavior !== 'allow' && behavior !== 'deny') return refuse('Unknown answer');
  if (body.choices !== undefined) return refuse('Choices do not belong to a permission request');
  return { ok: true, decision: behavior === 'allow' ? { behavior: 'allow' } : DENY };
}

/**
 * Whether a dialog is open in the row's session, so that a held request can still be answered
 * there. The registry says so itself ("waiting"). The derived state is not enough: an open
 * question in the transcript makes a row "prompt" even for a run that shows no dialog, and
 * holding that request would keep the run waiting for nobody. Only when the registry has no
 * status at all (an older Claude Code) does the derived state decide.
 */
function waitsForUser(row) {
  return typeof row.registryStatus === 'string' ? row.registryStatus === 'waiting' : row.state === 'prompt';
}

/**
 * The held requests. `hold` takes the request from `eligibility` and a function that answers
 * the waiting hook call: respond(decision) with a decision, respond(null) for "no decision".
 * It is called at most once per request. A request ends in exactly one way:
 *
 *   E1  answered in the panel                                    -> the decision
 *   E3  its session has been missing from the state for
 *       longer than the grace                                    -> no decision
 *   E4  no dialog is open in its session (see waitsForUser) and
 *       the request is older than the grace                      -> no decision
 *   E5  answering was switched off                               -> no decision
 *   E6  Claude Code closed the call                              -> nothing to send
 *   E7  the server shuts down                                    -> no decision
 *
 * E4 is how an answer given in the VS Code dialog is noticed: Claude Code leaves the hook call
 * open then, but the session goes back to work. Holding a request never ends another one: one
 * session can ask several things at once (parallel tool calls, subagents).
 */
export function createRequests({ now = Date.now, newId = randomUUID, graceMs = GRACE_MS, log = () => {} } = {}) {
  const held = new Map(); // id -> request, in the order they arrived

  /** Takes the request out first, then tells Claude Code: a respond that throws (the socket is
   *  gone) must neither keep the request nor stop the others. */
  function end(id, ending, decision = null) {
    const r = held.get(id);
    if (!r) return false;
    held.delete(id);
    if (ending !== 'E6') {
      try {
        r.respond(decision);
      } catch {
        // nobody is listening any more
      }
    }
    log({ ending, behavior: decision?.behavior ?? null, tool: r.tool, heldMs: now() - r.receivedAt, session: r.sessionId.slice(0, 8) });
    return true;
  }

  return {
    get size() {
      return held.size;
    },

    hold(request, respond) {
      const id = newId();
      held.set(id, { ...request, id, receivedAt: now(), respond });
      return id;
    },

    /** { ok: true } | { ok: false, gone: true } | { ok: false, reason } (a refusal to build). */
    answer(sessionId, requestId, body) {
      const r = held.get(requestId);
      if (!r || r.sessionId !== sessionId) return { ok: false, gone: true };
      const verdict = decisionFor(r, body);
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      end(requestId, 'E1', verdict.decision);
      return { ok: true };
    },

    /** rows: Map sessionId -> main agent row (see sessionRows). */
    reconcile(rows) {
      let ended = 0;
      for (const r of [...held.values()]) {
        const row = rows.get(r.sessionId);
        if (!row) {
          // One state without the session can be a torn read of its registry file, or a
          // registry that could not be read at all. Only an absence that lasts longer than the
          // grace counts as gone. It is not ridden out for longer either: a run without a
          // dialog must not wait on a server that cannot see whether it still asks.
          r.missingSince ??= now();
          if (now() - r.missingSince > graceMs) ended += end(r.id, 'E3');
          continue;
        }
        r.missingSince = null;
        if (!waitsForUser(row) && now() - r.receivedAt > graceMs) ended += end(r.id, 'E4');
      }
      return ended;
    },

    endAll(ending) {
      let ended = 0;
      for (const id of [...held.keys()]) ended += end(id, ending);
      return ended;
    },

    drop(id) {
      end(id, 'E6');
    },

    listFor(sessionId) {
      const out = [];
      for (const r of held.values()) {
        if (r.sessionId !== sessionId) continue;
        out.unshift({
          id: r.id, kind: r.kind, via: r.via, tool: r.tool, detail: r.detail, extras: r.extras,
          questions: r.questions, since: new Date(r.receivedAt).toISOString(),
        });
      }
      return out;
    },
  };
}

// ---------- HTTP ----------

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const isJson = (headers) => (headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
/** DNS-rebinding guard: the Host must be our own loopback origin. */
const hostOk = (req) => {
  const host = req.headers.host;
  const port = req.socket.localPort;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
};

/** The body as text, or null when it is larger than `limit`. A larger body is read to its end
 *  without being kept: leaving the loop early would reset the connection under a caller that
 *  is still sending, and it would never see the answer. */
async function readBody(req, limit) {
  let chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) chunks = [];
    else chunks.push(chunk);
  }
  return size > limit ? null : Buffer.concat(chunks).toString('utf8');
}

/**
 * getState({ fresh }) -> the state with agent rows (cached unless fresh); invalidate() drops the
 * server's state cache; enabled: boolean or function; log(line); pollMs: reconcile interval.
 * Returns the two route handlers plus what server.mjs needs for the state and the shutdown.
 */
export function createAnswering({
  getState, invalidate = () => {}, enabled = true, log = () => {}, pollMs = 2500,
  now = Date.now, graceMs = GRACE_MS,
}) {
  const on = () => (typeof enabled === 'function' ? enabled() : enabled) === true;
  const requests = createRequests({
    now,
    graceMs,
    log: (e) => log(`request ended: ${e.tool} ${e.ending}${e.behavior ? ` ${e.behavior}` : ''} after ${Math.round(e.heldMs / 1000)} s, session ${e.session}`),
  });

  // While a request is held, look at the sessions every pollMs, with or without a page
  // listening: a request whose session is gone or no longer asks was answered elsewhere.
  let watch = null;
  function watchRequests() {
    if (watch || requests.size === 0) return;
    watch = setTimeout(async () => {
      watch = null;
      try {
        requests.reconcile(sessionRows(await getState({ fresh: true })));
      } catch (err) {
        log(`held requests: collect failed: ${err?.message ?? err}`); // retried next tick
      }
      invalidate();
      watchRequests();
    }, pollMs);
  }

  const noDecision = (res) => {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(200);
    res.end();
  };
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  /** POST /api/hook/permission-request: Claude Code asks whether a tool call may run. Held for
   *  the panel when eligible; everything else, and every error, is "no decision" (200, empty). */
  async function handleHook(req, res) {
    const fromClaude = LOOPBACK.has(req.socket.remoteAddress ?? '') && hostOk(req)
      && req.method === 'POST' && req.headers.origin === undefined && isJson(req.headers);
    if (!fromClaude) {
      req.resume();
      return noDecision(res);
    }
    // Claude Code can give up on the call at any moment (hook timeout, session ended, "No" in
    // its own dialog), also while the session is still being looked up below. Remember it from
    // the start: a call nobody waits for must not become a request with buttons.
    let gone = false;
    let requestId = null;
    res.on('close', () => {
      gone = true;
      if (requestId !== null) requests.drop(requestId); // a no-op once it was answered
    });
    try {
      const text = await readBody(req, MAX_HOOK_BODY);
      if (text === null) return noDecision(res);
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return noDecision(res);
      }
      // The session's row: the cached state when it knows the id, else one fresh look
      // (a session that started a moment ago).
      const id = payload?.session_id;
      let session = null;
      if (on() && typeof id === 'string') {
        session = sessionRows(await getState()).get(id) ?? sessionRows(await getState({ fresh: true })).get(id) ?? null;
      }
      const verdict = eligibility({ payload, session, enabled: on(), heldCount: requests.size });
      if (gone) return undefined; // closed during the lookup: nothing to hold, nobody to answer
      if (!verdict.hold) return noDecision(res);

      requestId = requests.hold(verdict.request, (decision) => {
        if (decision === null) return noDecision(res);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
      });
      invalidate();
      watchRequests();
      return undefined;
    } catch (err) {
      log(`hook call passed through: ${err?.message ?? err}`);
      if (!gone) noDecision(res);
      return undefined;
    }
  }

  /** POST /api/answer: the user's click on a held request. The page names what was clicked;
   *  the decision is built here. */
  async function handleAnswer(req, res) {
    const refused = (status, error) => {
      req.resume();
      return json(res, status, { ok: false, error });
    };
    if (req.method !== 'POST') return refused(405, 'POST only');
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return refused(403, 'Local only');
    if (!hostOk(req)) return refused(403, 'Foreign host');
    if (req.headers.origin !== `http://${req.headers.host}`) return refused(403, 'Foreign origin');
    if (!isJson(req.headers)) return refused(415, 'Content-type must be application/json');
    const text = await readBody(req, MAX_ANSWER_BODY);
    if (text === null) return json(res, 413, { ok: false, error: 'Request too large' });
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json(res, 400, { ok: false, error: 'Not valid JSON' });
    }
    if (!isObj(body) || typeof body.sessionId !== 'string' || !UUID.test(body.sessionId)) {
      return json(res, 400, { ok: false, error: 'Not a valid session id' });
    }
    if (typeof body.requestId !== 'string' || body.requestId === '') {
      return json(res, 400, { ok: false, error: 'Not a valid request id' });
    }
    const answered = requests.answer(body.sessionId, body.requestId, body);
    if (answered.gone) return json(res, 200, { ok: false, error: 'gone' });
    if (!answered.ok) return json(res, 400, { ok: false, error: answered.reason });
    invalidate();
    return json(res, 200, { ok: true });
  }

  return {
    handleHook,
    handleAnswer,
    listFor: (sessionId) => requests.listFor(sessionId),
    /** Ends every held request; clears the watch timer. */
    endAll(ending) {
      const n = requests.endAll(ending);
      clearTimeout(watch);
      watch = null;
      return n;
    },
    get size() {
      return requests.size;
    },
  };
}
