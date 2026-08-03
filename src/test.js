/* ClaudeQue tests — drives the hook with synthetic Claude Code payloads. */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const q = require('./queue');

const HOOK = path.join(__dirname, 'hook.js');
const CWD = path.join(__dirname, '..', '.testcwd');

fs.rmSync(CWD, { recursive: true, force: true });
fs.mkdirSync(CWD, { recursive: true });

function stop(payload = {}, env = {}) {
  const r = spawnSync(process.execPath, [HOOK, 'stop'], {
    input: JSON.stringify({ cwd: CWD, session_id: 's1', ...payload }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return r.stdout.trim();
}

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      actual:   ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------- queue api

const multi = 'refactor auth\n\n- keep the API stable\n- add tests';
const a = q.add(CWD, multi);
const b = q.add(CWD, 'second task');
const c = q.add(CWD, 'third task');

check('three items queued', q.load(CWD).items.length, 3);
check('multi-line body preserved', q.load(CWD).items[0].text, multi);
check('ids are unique', new Set([a.id, b.id, c.id]).size, 3);
check('blank text is rejected', q.add(CWD, '   '), null);

check('move down reorders', q.move(CWD, a.id, 1), true);
check('  a is now second', q.load(CWD).items[1].id, a.id);
check('move back up', q.move(CWD, a.id, -1), true);
check('move past the end is refused', q.move(CWD, c.id, 1), false);
check('move before the start is refused', q.move(CWD, a.id, -1), false);

check('update rewrites text', q.update(CWD, b.id, 'second task v2'), true);
check('  text changed', q.load(CWD).items[1].text, 'second task v2');
check('update to blank is refused', q.update(CWD, b.id, '  '), false);
check('update of unknown id is refused', q.update(CWD, 'nope', 'x'), false);

check('remove drops one', q.remove(CWD, b.id), true);
check('  two remain', q.load(CWD).items.length, 2);
check('remove of unknown id is refused', q.remove(CWD, 'nope'), false);

// Shared-mutable-default regression: two loads of a missing queue must not
// share an items array, or the first push poisons every later clear().
const miss1 = q.load(path.join(CWD, 'nope-a'));
const miss2 = q.load(path.join(CWD, 'nope-b'));
miss1.items.push({ id: 'x', text: 'leak' });
check('missing-file loads are independent', miss2.items.length, 0);
check('a fresh empty state is unpolluted', q.emptyState().items.length, 0);

q.clear(CWD);
check('clear really empties', q.load(CWD).items.length, 0);
q.add(CWD, 'after clear');
q.clear(CWD);
check('clear after add stays empty', q.load(CWD).items.length, 0);

// Restore a known 3-item queue for the hook tests.
q.clear(CWD);
q.add(CWD, multi);
q.add(CWD, 'second task');
q.add(CWD, 'third task');

// ---------------------------------------------------------------- hook

// Each real stop carries a distinct last_assistant_message — that is what
// separates iterations within a single turn.
const s1 = JSON.parse(stop({ stop_hook_active: false, last_assistant_message: 'r1' }));
check('stop returns block', s1.decision, 'block');
check('injects first item', s1.reason.includes('refactor auth'), true);
check('newlines survive injection', s1.reason.includes('- add tests'), true);
check('framing prefix applied', s1.reason.startsWith('New queued task'), true);

const s2 = JSON.parse(stop({ stop_hook_active: true, last_assistant_message: 'r2' }));
check('second pop is item two', s2.reason.includes('second task'), true);

const s3 = JSON.parse(stop({ stop_hook_active: true, last_assistant_message: 'r3' }));
check('third pop is item three', s3.reason.includes('third task'), true);

check(
  'empty queue returns {}',
  stop({ stop_hook_active: true, last_assistant_message: 'r4' }),
  '{}'
);

// A simultaneous double-fire of the SAME stop must pop only once...
q.add(CWD, 'dup-A');
q.add(CWD, 'dup-B');
q.add(CWD, 'dup-C');
const same = { prompt_id: 't1', last_assistant_message: 'done with A' };
check('first invocation pops', JSON.parse(stop(same)).reason.includes('dup-A'), true);
check('simultaneous double-fire is a no-op', stop(same), '{}');

// ...but the next iteration of the SAME turn must still pop: injected prompts
// continue one turn, so prompt_id never changes — only the reply does.
check(
  'same prompt_id, new reply still pops',
  JSON.parse(stop({ prompt_id: 't1', last_assistant_message: 'done with B' }))
    .reason.includes('dup-B'),
  true
);

// An identical reply outside the dedupe window must also pop.
check(
  'repeat reply outside window still pops',
  JSON.parse(
    stop(
      { prompt_id: 't1', last_assistant_message: 'done with B' },
      { CLAUDEQUE_DEDUPE_MS: '1' }
    )
  ).reason.includes('dup-C'),
  true
);

// Paused queue holds.
q.add(CWD, 'held');
q.setPaused(CWD, true);
check('paused queue returns {}', stop({ last_assistant_message: 'r6' }), '{}');
check('  item is still held', q.load(CWD).items.length, 1);
q.setPaused(CWD, false);
check(
  'resumed queue pops',
  JSON.parse(stop({ last_assistant_message: 'r7' })).reason.includes('held'),
  true
);

// ---------------------------------------------------------------- enqueue

function enqueue(prompt) {
  const r = spawnSync(process.execPath, [HOOK, 'enqueue'], {
    input: JSON.stringify({ cwd: CWD, session_id: 's1', prompt }),
    encoding: 'utf8',
  });
  return r.stdout.trim();
}

q.clear(CWD);
check('a plain prompt passes through', enqueue('hello there'), '');
check('  nothing was queued', q.load(CWD).items.length, 0);

const eq = JSON.parse(enqueue('que: refactor the parser'));
check('  the task is queued', q.load(CWD).items[0].text, 'refactor the parser');
// Must NOT block: a blocked prompt starts no turn, and the queue only advances
// when a turn ends — which parked the queue indefinitely.
check('que: does not block the prompt', eq.decision, undefined);
check(
  '  it steers via additionalContext instead',
  eq.hookSpecificOutput.additionalContext.includes('do NOT do it now'),
  true
);

enqueue('queue: alias two');
enqueue('NEXT: alias three');
enqueue('q: alias four');
check('all four trigger words work', q.load(CWD).items.length, 4);

const body = 'que: fix the header\n\n- keep it centred\n- add a test';
q.clear(CWD);
enqueue(body);
check('multi-line body is ONE item', q.load(CWD).items.length, 1);
check(
  '  and kept whole',
  q.load(CWD).items[0].text,
  'fix the header\n\n- keep it centred\n- add a test'
);

// One trigger per line queues separate items.
q.clear(CWD);
enqueue('que: something 1\nque: something 2\nq: something 3');
check('one trigger per line = separate items', q.load(CWD).items.length, 3);
check('  first', q.load(CWD).items[0].text, 'something 1');
check('  third', q.load(CWD).items[2].text, 'something 3');

// A trigger mid-message still splits, and its body still keeps its own lines.
q.clear(CWD);
enqueue('que: task A\n  continued A\nque: task B');
check('mixed multi-line and split', q.load(CWD).items.length, 2);
check('  body A keeps its second line', q.load(CWD).items[0].text, 'task A\n  continued A');
check('  body B', q.load(CWD).items[1].text, 'task B');

check('bare trigger with no text passes through', enqueue('que:'), '');
q.clear(CWD);

// ---------------------------------------------------------------- parking

q.clear(CWD);
q.clearParked(CWD);
q.add(CWD, 'task that continues');
const parked = q.park(CWD, 'blocked task', 'which database?');
check('park records the task', parked.text, 'blocked task');
check('  and the reason', q.loadParked(CWD)[0].reason, 'which database?');
check('  parking does not touch the queue', q.load(CWD).items.length, 1);
check('park of blank text is refused', q.park(CWD, '   ', 'why'), null);
q.park(CWD, 'second blocked', '');
check('missing reason gets a placeholder', q.loadParked(CWD)[1].reason, 'No reason given.');
check('two parked', q.loadParked(CWD).length, 2);
q.clearParked(CWD);
check('unpark empties', q.loadParked(CWD).length, 0);
check('  queue still intact', q.load(CWD).items.length, 1);

// The injected prompt must tell an unattended run not to ask questions.
const inj = JSON.parse(stop({ last_assistant_message: 'rP' }));
check('injection forbids clarifying questions',
  inj.reason.includes('Do NOT ask clarifying questions'), true);
check('  and offers parking as the escape hatch', inj.reason.includes('park'), true);
q.clear(CWD);

// ---------------------------------------------------------------- cli

function cli(...args) {
  const r = spawnSync(process.execPath, [HOOK, ...args], {
    encoding: 'utf8',
    cwd: CWD,
  });
  return { out: r.stdout.trim(), code: r.status };
}

q.clear(CWD);
cli('add', 'alpha');
cli('add', 'beta');
cli('add', 'gamma');
check('add via CLI', q.load(CWD).items.length, 3);

cli('move', '3', 'up');
check('move up reorders', q.load(CWD).items.map((i) => i.text), ['alpha', 'gamma', 'beta']);
cli('move', '1', 'down');
check('move down reorders', q.load(CWD).items.map((i) => i.text), ['gamma', 'alpha', 'beta']);
check('move needs a direction', cli('move', '1', 'sideways').code, 1);
check('move rejects out of range', cli('move', '9', 'up').code, 1);

cli('edit', '2', 'alpha revised');
check('edit rewrites an item', q.load(CWD).items[1].text, 'alpha revised');
check('edit rejects blank text', cli('edit', '2', '   ').code, 1);
check('edit rejects out of range', cli('edit', '9', 'x').code, 1);

cli('remove', '1');
check('remove drops one', q.load(CWD).items.length, 2);
cli('pause');
check('pause sets the flag', q.load(CWD).paused, true);
cli('resume');
check('resume clears it', q.load(CWD).paused, false);
cli('clear');
check('clear empties', q.load(CWD).items.length, 0);
check('unknown command exits non-zero', cli('flibble').code, 1);

// ---------------------------------------------------------------- pretool

function pretool(tool = 'Bash') {
  const r = spawnSync(process.execPath, [HOOK, 'pretool'], {
    input: JSON.stringify({ cwd: CWD, session_id: 's1', tool_name: tool,
      tool_input: { command: 'echo hi' } }),
    encoding: 'utf8',
  });
  return r.stdout.trim();
}

q.clear(CWD);
q.add(CWD, 'a queued task');

// Ordinary tools are never touched — whatever gate the session has is unchanged.
check('ordinary tool during a run: not interfered with', pretool('Bash'), '');
check('ordinary tool while idle: not interfered with', pretool('Edit'), '');

// AskUserQuestion stalls a queue even under bypassPermissions: the tool renders
// a dialog and waits, so the turn never ends and no Stop hook fires.
const denied = JSON.parse(pretool('AskUserQuestion'));
check('queue running: AskUserQuestion is DENIED',
  denied.hookSpecificOutput.permissionDecision, 'deny');
check('  and told to decide instead',
  denied.hookSpecificOutput.permissionDecisionReason.includes('Do not ask'), true);
check('  with parking as the escape hatch',
  denied.hookSpecificOutput.permissionDecisionReason.includes('park'), true);
check('  denial is logged',
  fs.readFileSync(q.logPath(CWD), 'utf8').includes('"event":"deny-question"'), true);

q.setPaused(CWD, true);
check('paused: AskUserQuestion is left alone', pretool('AskUserQuestion'), '');
q.setPaused(CWD, false);

// Last item still executing: queue is empty but the run is not over.
q.clear(CWD);
q.save(CWD, { ...q.emptyState(), consecutiveBlocks: 1, lastPopAt: Date.now() });
check('final item still running: still denied',
  JSON.parse(pretool('AskUserQuestion')).hookSpecificOutput.permissionDecision, 'deny');

// Once a run is over, asking must work normally again.
q.save(CWD, { ...q.emptyState(), consecutiveBlocks: 1, lastPopAt: Date.now() - 20 * 60 * 1000 });
check('stale run: AskUserQuestion allowed again', pretool('AskUserQuestion'), '');

q.clear(CWD);
check('no queue at all: AskUserQuestion allowed', pretool('AskUserQuestion'), '');

// Malformed input must not throw or emit.
const bad = spawnSync(process.execPath, [HOOK, 'stop'], {
  input: 'not json',
  encoding: 'utf8',
  cwd: CWD,
});
check('malformed input exits 0', bad.status, 0);
check('malformed input emits nothing', bad.stdout.trim(), '');

// A UTF-8 BOM must not break parsing.
q.add(CWD, 'bom task');
const bom = spawnSync(process.execPath, [HOOK, 'stop'], {
  input: '﻿' + JSON.stringify({ cwd: CWD, last_assistant_message: 'r8' }),
  encoding: 'utf8',
});
check('BOM-prefixed input still pops', JSON.parse(bom.stdout).reason.includes('bom task'), true);

// No temp files may survive a write.
const strays = fs.readdirSync(q.stateDir(CWD)).filter((f) => f.endsWith('.tmp'));
check('no stray temp files', strays, []);

console.log(`\n${failures === 0 ? 'All tests passed.' : failures + ' FAILURE(S).'}`);
fs.rmSync(CWD, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
