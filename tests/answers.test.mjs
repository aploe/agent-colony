// Held permission requests: the rules (eligibility, decisionFor, createRequests) and the two
// routes of createAnswering on a real http server with a stub state. All sessions, commands and
// questions are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  DENY, MAX_DETAIL, MAX_HELD, createAnswering, createRequests, decisionFor, eligibility,
  requestDetail, requestQuestions, sessionRows,
} from '../src/answers.mjs';

const S1 = '123e4567-e89b-42d3-a456-426614174010'; // VS Code
const S2 = '123e4567-e89b-42d3-a456-426614174011'; // terminal
const S3 = '123e4567-e89b-42d3-a456-426614174012'; // VS Code, process gone
const NOBODY = '123e4567-e89b-42d3-a456-426614174999';
const bash = (id = S1, command = 'rm -rf build/tmp') =>
  ({ hook_event_name: 'PermissionRequest', session_id: id, tool_name: 'Bash', tool_input: { command } });
const ask = (questions, id = S1) =>
  ({ hook_event_name: 'PermissionRequest', session_id: id, tool_name: 'AskUserQuestion', tool_input: { questions } });
const Q = (question, labels, multiSelect = false) =>
  ({ question, header: 'H', multiSelect, options: labels.map((label) => ({ label, description: `d ${label}` })) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => 'pending')]);
async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(10);
  }
}

const row = (extra = {}) => ({ sessionId: S1, sub: false, open: true, entrypoint: 'claude-vscode', registryStatus: 'waiting', state: 'prompt', ...extra });

// ---- helpers ----------------------------------------------------------------------------

test('requestDetail: whole command, other inputs as extras, too long = null', () => {
  assert.deepEqual(requestDetail('Bash', { command: 'ls', description: 'x', timeout: 5 }), { detail: 'ls', extras: ['timeout: 5'] });
  assert.deepEqual(requestDetail('Write', { file_path: '/a/b', content: 'secret' }), { detail: '/a/b', extras: [] });
  assert.equal(requestDetail('Bash', { command: 'x'.repeat(MAX_DETAIL + 1) }), null);
  assert.equal(requestDetail('Bash', {}), null);
  assert.deepEqual(requestDetail('Grep', { pattern: 'a' }), { detail: '{"pattern":"a"}', extras: [] });
});

test('requestQuestions: 1-4 questions, two labelled options, unique texts and labels', () => {
  assert.equal(requestQuestions({ questions: [Q('a?', ['x', 'y'])] })[0].options[1].description, 'd y');
  assert.equal(requestQuestions({ questions: [] }), null);
  assert.equal(requestQuestions({ questions: [Q('a?', ['x'])] }), null);
  assert.equal(requestQuestions({ questions: [Q('a?', ['x', 'x'])] }), null);
  assert.equal(requestQuestions({ questions: [Q('a?', ['x', 'y']), Q('a?', ['x', 'y'])] }), null);
  assert.equal(requestQuestions({ questions: Array.from({ length: 5 }, (_, i) => Q(`q${i}`, ['x', 'y'])) }), null);
});

test('sessionRows: main agents of hexes and stations only', () => {
  const st = { planets: [{ hexes: [{ agents: [row(), row({ sessionId: S2, sub: true })] }], station: { agents: [row({ sessionId: S3 })] } }] };
  assert.deepEqual([...sessionRows(st).keys()].sort(), [S1, S3]);
});

// ---- eligibility ------------------------------------------------------------------------

test('eligibility: held only for an open VS Code main session with a showable request', () => {
  const ok = (over = {}) => eligibility({ payload: bash(), session: row(), enabled: true, heldCount: 0, ...over });
  assert.equal(ok().hold, true);
  assert.equal(ok().request.via, 'main');
  assert.equal(ok({ payload: { ...bash(), agent_id: 'a1' } }).request.via, 'subagent');
  assert.equal(ok({ enabled: false }).why, 'off');
  assert.equal(ok({ session: null }).why, 'session');
  assert.equal(ok({ session: row({ entrypoint: 'cli' }) }).why, 'session');
  assert.equal(ok({ session: row({ entrypoint: null }) }).why, 'session');
  assert.equal(ok({ session: row({ open: false }) }).why, 'session');
  assert.equal(ok({ session: row({ open: null }) }).why, 'session');
  assert.equal(ok({ payload: { ...bash(), tool_name: 'ExitPlanMode' } }).why, 'plan');
  assert.equal(ok({ payload: { ...bash(), hook_event_name: 'Stop' } }).why, 'payload');
  assert.equal(ok({ payload: { ...bash(), session_id: 'nope' } }).why, 'payload');
  assert.equal(ok({ payload: ask([Q('a?', ['x'])]) }).why, 'questions');
  assert.equal(ok({ payload: bash(S1, 'x'.repeat(MAX_DETAIL + 1)) }).why, 'detail');
  assert.equal(ok({ heldCount: MAX_HELD }).why, 'full');
  assert.equal(ok({ payload: ask([Q('a?', ['x', 'y'])]) }).request.kind, 'question');
});

// ---- decisionFor ------------------------------------------------------------------------

test('decisionFor: allow, deny with interrupt, refusals', () => {
  const perm = { kind: 'permission' };
  assert.deepEqual(decisionFor(perm, { behavior: 'allow' }), { ok: true, decision: { behavior: 'allow' } });
  assert.deepEqual(decisionFor(perm, { behavior: 'deny' }).decision, DENY);
  assert.deepEqual(DENY, { behavior: 'deny', message: 'Denied by the user in Agent Colony.', interrupt: true });
  assert.equal(decisionFor(perm, { behavior: 'maybe' }).ok, false);
  assert.equal(decisionFor(perm, { behavior: 'allow', choices: [[0]] }).ok, false);
  assert.equal(decisionFor(perm, null).ok, false);
});

test('decisionFor: a question is answered by option index with the labels, in option order', () => {
  const questions = [Q('one?', ['a', 'b', 'c']), Q('two?', ['x', 'y', 'z'], true)];
  const req = { kind: 'question', questions, toolInput: { questions: [{ question: 'one?' }], keep: 1 } };
  const v = decisionFor(req, { behavior: 'allow', choices: [[2], [2, 0]] });
  assert.deepEqual(v.decision, { behavior: 'allow', updatedInput: { questions: [{ question: 'one?' }], keep: 1, answers: { 'one?': 'c', 'two?': 'x, z' } } });
  for (const choices of [[[0]], [[0], []], [[0, 1], [0]], [[3], [0]], [[0], [0, 0]], [[0], ['0']], 'x', undefined]) {
    assert.equal(decisionFor(req, { behavior: 'allow', choices }).ok, false, JSON.stringify(choices));
  }
  assert.equal(decisionFor(req, { behavior: 'deny' }).ok, false);
});

// ---- createRequests: the endings -------------------------------------------------------

function store(graceMs = 100) {
  let t = 1000;
  const sent = [];
  const logs = [];
  const r = createRequests({ now: () => t, graceMs, log: (e) => logs.push(e), newId: (() => { let n = 0; return () => `id${++n}`; })() });
  const hold = (sessionId = S1) => {
    const request = { sessionId, via: 'main', tool: 'Bash', kind: 'permission', detail: 'ls', extras: [], questions: null };
    return r.hold(request, (d) => sent.push([sessionId, d]));
  };
  return { r, sent, logs, hold, tick: (ms) => { t += ms; } };
}

test('E1: the answer is sent once; a second answer finds nothing', () => {
  const s = store();
  const id = s.hold();
  assert.deepEqual(s.r.answer(S1, id, { behavior: 'allow' }), { ok: true });
  assert.deepEqual(s.sent, [[S1, { behavior: 'allow' }]]);
  assert.deepEqual(s.r.answer(S1, id, { behavior: 'allow' }), { ok: false, gone: true });
  assert.equal(s.sent.length, 1);
  assert.equal(s.logs[0].ending, 'E1');
});

test('an answer for another session or a refused answer leaves the request held', () => {
  const s = store();
  const id = s.hold();
  assert.equal(s.r.answer(S2, id, { behavior: 'allow' }).gone, true);
  assert.equal(s.r.answer(S1, id, { behavior: 'bogus' }).ok, false);
  assert.equal(s.r.size, 1);
  assert.deepEqual(s.sent, []);
});

test('E3: a session missing longer than the grace ends the request; one torn read does not', () => {
  const s = store(100);
  s.hold();
  s.r.reconcile(new Map());
  s.tick(50);
  s.r.reconcile(new Map());
  assert.equal(s.r.size, 1);
  s.r.reconcile(new Map([[S1, row()]])); // back: the clock restarts
  s.tick(80);
  s.r.reconcile(new Map());
  s.tick(80);
  assert.equal(s.r.size, 1);
  s.tick(40);
  s.r.reconcile(new Map());
  assert.equal(s.r.size, 0);
  assert.deepEqual(s.sent, [[S1, null]]);
  assert.equal(s.logs[0].ending, 'E3');
});

test('a torn registry read (row listed, not open, no status) counts as missing, not as E4', () => {
  const s = store(100);
  s.hold();
  s.tick(150); // past the grace: an E4 would end it at once
  const torn = row({ open: false, registryStatus: null, state: 'idle' });
  s.r.reconcile(new Map([[S1, torn]]));
  assert.equal(s.r.size, 1, 'one torn read must not end the request');
  s.r.reconcile(new Map([[S1, row()]])); // the next read is whole again
  s.tick(80);
  s.r.reconcile(new Map([[S1, row({ open: null, registryStatus: null })]]));
  assert.equal(s.r.size, 1);
  s.tick(120);
  s.r.reconcile(new Map([[S1, torn]]));
  assert.equal(s.r.size, 0, 'an absence longer than the grace ends it');
  assert.equal(s.logs[0].ending, 'E3');
});

test('E4: no dialog open after the grace ends the request; registry beats state; no registry falls back to state', () => {
  const s = store(100);
  s.hold();
  s.r.reconcile(new Map([[S1, row({ registryStatus: 'busy' })]]));
  assert.equal(s.r.size, 1, 'inside the grace');
  s.tick(150);
  s.r.reconcile(new Map([[S1, row({ registryStatus: 'waiting', state: 'working' })]]));
  assert.equal(s.r.size, 1, 'registry says waiting');
  s.r.reconcile(new Map([[S1, row({ registryStatus: null, state: 'prompt' })]]));
  assert.equal(s.r.size, 1, 'no registry status, state prompt');
  s.r.reconcile(new Map([[S1, row({ registryStatus: 'busy', state: 'prompt' })]]));
  assert.equal(s.r.size, 0);
  assert.equal(s.logs[0].ending, 'E4');
  const t = store(100);
  t.hold();
  t.tick(150);
  t.r.reconcile(new Map([[S1, row({ registryStatus: null, state: 'working' })]]));
  assert.equal(t.r.size, 0, 'no registry status, state working');
});

test('E4 ends only requests of the session that stopped asking; several per session coexist', () => {
  const s = store(100);
  s.hold(S1);
  s.hold(S1);
  s.hold(S3);
  s.tick(150);
  s.r.reconcile(new Map([[S1, row()], [S3, row({ sessionId: S3, registryStatus: 'busy' })]]));
  assert.equal(s.r.size, 2);
  assert.equal(s.r.listFor(S1).length, 2);
});

test('E6: a closed call is dropped without a response; E7 answers everything with no decision; throwing respond is survived', () => {
  const s = store();
  const a = s.hold();
  s.r.drop(a);
  assert.equal(s.r.size, 0);
  assert.deepEqual(s.sent, []);
  assert.equal(s.logs[0].ending, 'E6');
  s.hold();
  s.r.hold({ sessionId: S1, tool: 'Bash' }, () => { throw new Error('socket gone'); });
  s.hold();
  assert.equal(s.r.endAll('E7'), 3);
  assert.equal(s.sent.length, 2);
  assert.deepEqual(s.sent.map(([, d]) => d), [null, null]);
});

test('listFor: newest first, only that session', () => {
  const s = store();
  s.hold(S1);
  s.hold(S2);
  s.tick(5);
  s.hold(S1);
  assert.deepEqual(s.r.listFor(S1).map((r) => r.id), ['id3', 'id1']);
  assert.deepEqual(Object.keys(s.r.listFor(S2)[0]).sort(), ['detail', 'extras', 'id', 'kind', 'questions', 'since', 'tool', 'via']);
});

// ---- the routes -------------------------------------------------------------------------

async function start({ enabled = true, rows, getState } = {}) {
  const agents = rows ?? [row(), row({ sessionId: S2, entrypoint: 'cli' })];
  const lines = [];
  let invalidated = 0;
  const answering = createAnswering({
    getState: getState ?? (async () => ({ planets: [{ hexes: [{ agents }] }] })),
    invalidate: () => { invalidated++; },
    enabled,
    log: (l) => lines.push(l),
    pollMs: 30,
    graceMs: 80,
  });
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/api/hook/permission-request') return answering.handleHook(req, res);
    if (p === '/api/answer') return answering.handleAnswer(req, res);
    res.writeHead(404).end();
    return undefined;
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const hook = (payload, { headers = { 'content-type': 'application/json' }, raw } = {}) => {
    const body = raw ?? JSON.stringify(payload);
    let request;
    const answered = new Promise((resolve, reject) => {
      request = http.request({ host: '127.0.0.1', port, path: '/api/hook/permission-request', method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] ?? null, text }));
      });
      request.on('error', reject);
      request.end(body);
    });
    answered.catch(() => {});
    answered.request = request;
    return answered;
  };
  const post = (body, { origin = base, raw, headers = {} } = {}) => fetch(`${base}/api/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...headers },
    body: raw ?? JSON.stringify(body),
  });
  const listed = (id = S1) => answering.listFor(id);
  const stop = async () => {
    answering.endAll('E7');
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  };
  return { answering, server, base, port, hook, post, lines, listed, stop, agents, get invalidated() { return invalidated; } };
}
const NO_DECISION = { status: 200, type: null, text: '' };

test('hook: an eligible call is held, answered, and the hook gets the exact decision body', async () => {
  const t = await start();
  try {
    const call = t.hook(bash());
    assert.equal(await within(call, 100), 'pending');
    const [r] = t.listed();
    assert.equal(r.tool, 'Bash');
    assert.equal(t.invalidated > 0, true);
    const res = await t.post({ sessionId: S1, requestId: r.id, behavior: 'allow' });
    assert.deepEqual(await res.json(), { ok: true });
    const out = await call;
    assert.equal(out.status, 200);
    assert.equal(out.type, 'application/json');
    assert.equal(out.text, '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}');
    assert.deepEqual(t.listed(), []);
    assert.match(t.lines.at(-1), /^request ended: Bash E1 allow after \d+ s, session 123e4567$/);
    assert.equal(t.lines.at(-1).includes('rm -rf'), false);
  } finally { await t.stop(); }
});

test('hook: deny sends the interrupting decision byte for byte', async () => {
  const t = await start();
  try {
    const call = t.hook(bash());
    await until(() => t.listed().length === 1);
    await t.post({ sessionId: S1, requestId: t.listed()[0].id, behavior: 'deny' });
    assert.equal((await call).text, '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied by the user in Agent Colony.","interrupt":true}}}');
  } finally { await t.stop(); }
});

test('hook: a question is answered with updatedInput.answers', async () => {
  const t = await start();
  try {
    const questions = [Q('Which?', ['a', 'b'])];
    const call = t.hook(ask(questions));
    await until(() => t.listed().length === 1);
    assert.equal(t.listed()[0].kind, 'question');
    await t.post({ sessionId: S1, requestId: t.listed()[0].id, behavior: 'allow', choices: [[1]] });
    const body = JSON.parse((await call).text);
    assert.deepEqual(body.hookSpecificOutput.decision, { behavior: 'allow', updatedInput: { questions, answers: { 'Which?': 'b' } } });
  } finally { await t.stop(); }
});

test('hook: everything not held gets status 200 and an empty body at once', async () => {
  const t = await start();
  try {
    const calls = {
      terminal: t.hook(bash(S2)),
      unknown: t.hook(bash(NOBODY)),
      plan: t.hook({ ...bash(), tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } }),
      notJson: t.hook(null, { raw: '{nope' }),
      huge: t.hook({ ...bash(), pad: 'x'.repeat(1024 * 1024) }),
      wrongType: t.hook(bash(), { headers: { 'content-type': 'text/plain' } }),
      withOrigin: t.hook(bash(), { headers: { 'content-type': 'application/json', origin: t.base } }),
      wrongHost: t.hook(bash(), { headers: { 'content-type': 'application/json', host: 'evil.example' } }),
    };
    for (const [name, call] of Object.entries(calls)) assert.deepEqual(await within(call, 1500), NO_DECISION, name);
    assert.equal(t.answering.size, 0);
  } finally { await t.stop(); }
});

test('hook: answerInPanel off, and a throwing state, both pass through', async () => {
  const off = await start({ enabled: false });
  try {
    assert.deepEqual(await within(off.hook(bash()), 1000), NO_DECISION);
  } finally { await off.stop(); }
  const broken = await start({ getState: async () => { throw new Error('collect failed'); } });
  try {
    assert.deepEqual(await within(broken.hook(bash()), 1000), NO_DECISION);
    assert.equal(broken.lines.some((l) => l.includes('passed through')), true);
  } finally { await broken.stop(); }
});

test('hook: a call closed by the client drops its request (E6) and a call closed during lookup is never held', async () => {
  const t = await start();
  try {
    const call = t.hook(bash());
    await until(() => t.listed().length === 1);
    call.request.destroy();
    await until(() => t.answering.size === 0);
  } finally { await t.stop(); }
  let release;
  const slow = await start({ getState: () => new Promise((r) => { release = () => r({ planets: [{ hexes: [{ agents: [row()] }] }] }); }) });
  try {
    const call = slow.hook(bash());
    await until(() => release);
    call.request.destroy();
    await sleep(30);
    release();
    await sleep(50);
    assert.equal(slow.answering.size, 0);
  } finally { await slow.stop(); }
});

test('reconcile timer: a request whose session stops asking ends with no decision on its own', async () => {
  const t = await start();
  try {
    const call = t.hook(bash());
    await until(() => t.listed().length === 1);
    t.agents[0].registryStatus = 'busy';
    assert.deepEqual(await within(call, 1500), NO_DECISION);
    assert.match(t.lines.at(-1), /^request ended: Bash E4 after \d+ s, session 123e4567$/);
  } finally { await t.stop(); }
});

test('E7: endAll answers held calls with no decision', async () => {
  const t = await start();
  try {
    const call = t.hook(bash());
    await until(() => t.listed().length === 1);
    t.answering.endAll('E7');
    assert.deepEqual(await within(call, 500), NO_DECISION);
  } finally { await t.stop(); }
});

test('answer: guards and validation', async () => {
  const t = await start();
  try {
    const call = t.hook(bash());
    await until(() => t.listed().length === 1);
    const id = t.listed()[0].id;
    const good = { sessionId: S1, requestId: id, behavior: 'allow' };
    const cases = [
      ['no origin', await t.post(good, { origin: null }), 403],
      ['foreign origin', await t.post(good, { origin: 'http://evil.example' }), 403],
      ['origin of another port', await t.post(good, { origin: 'http://127.0.0.1:1' }), 403],
      ['wrong content type', await fetch(`${t.base}/api/answer`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: t.base }, body: JSON.stringify(good) }), 415],
      ['wrong host', await t.post(good, { headers: { host: 'evil.example' }, origin: 'http://evil.example' }), 403],
      ['GET', await fetch(`${t.base}/api/answer`), 405],
      ['not JSON', await t.post(null, { raw: '{nope' }), 400],
      ['bad session id', await t.post({ ...good, sessionId: 'x' }), 400],
      ['no request id', await t.post({ ...good, requestId: 5 }), 400],
      ['unknown behavior', await t.post({ ...good, behavior: 'maybe' }), 400],
      ['too large', await t.post({ ...good, pad: 'x'.repeat(5000) }), 413],
    ];
    for (const [name, res, status] of cases) {
      assert.equal(res.status, status, name);
      const body = await res.json();
      assert.equal(body.ok, false, name);
      assert.equal(typeof body.error, 'string', name);
    }
    assert.equal(t.answering.size, 1, 'nothing above ended the request');
    const gone = await t.post({ ...good, requestId: 'nope' });
    assert.deepEqual({ status: gone.status, body: await gone.json() }, { status: 200, body: { ok: false, error: 'gone' } });
    const other = await t.post({ ...good, sessionId: S2 });
    assert.equal((await other.json()).error, 'gone');
    assert.equal((await t.post({ ...good, origin: undefined })).status, 200);
    assert.equal((await within(call, 500)).status, 200);
    const again = await t.post(good);
    assert.deepEqual(await again.json(), { ok: false, error: 'gone' });
  } finally { await t.stop(); }
});

test('hold limit: the 51st eligible call is not held', async () => {
  const t = await start();
  try {
    for (let i = 0; i < MAX_HELD; i++) t.hook(bash(S1, `echo ${i}`));
    await until(() => t.answering.size === MAX_HELD, 5000);
    assert.deepEqual(await within(t.hook(bash(S1, 'echo extra')), 1000), NO_DECISION);
    assert.equal(t.answering.size, MAX_HELD);
  } finally { await t.stop(); }
});
