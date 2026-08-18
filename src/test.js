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
// A popped item has left the queue, so its text must be recorded or the item
// being worked on cannot be named — especially the last one of a run.
check('the running item is recorded', q.load(CWD).lastItem, 'third task');

// Emptying the queue ends the run, which asks once whether anything should
// follow; only after that does Claude get to stop.
check(
  'emptying asks for a wrap-up first',
  JSON.parse(stop({ stop_hook_active: true, last_assistant_message: 'r4' }))
    .reason.includes('queue is now empty'),
  true
);
check(
  'empty queue then returns {}',
  stop({ stop_hook_active: true, last_assistant_message: 'r5' }),
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

// Starting a run asks Claude to launch the watcher as a background task —
// hooks cannot register one themselves, and it is the only visible surface.
const firstOfRun = JSON.parse(enqueue('que: refactor the parser'));
check('first item of a run asks for the watcher',
  firstOfRun.hookSpecificOutput.additionalContext.includes('run_in_background'), true);
check('  and passes the project directory',
  firstOfRun.hookSpecificOutput.additionalContext.includes('watch "'), true);

// Adding to a run already under way must not ask again, or every que: would
// spawn another watcher.
const secondOfRun = JSON.parse(enqueue('que: and another thing'));
check('later items do not ask again',
  secondOfRun.hookSpecificOutput.additionalContext.includes('run_in_background'), false);

q.clear(CWD);
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

// ---------------------------------------------------------------- attach

// The queue is text, so an image must be copied somewhere durable: a task may
// not run for hours, by which time a temp file is gone.
const srcDir = path.join(CWD, 'src-images');
fs.mkdirSync(srcDir, { recursive: true });
const shot = path.join(srcDir, 'shop tabs.png');
fs.writeFileSync(shot, 'not really a png');

const attached = q.attach(CWD, shot);
check('attach copies the file', fs.existsSync(attached), true);
check('  contents preserved', fs.readFileSync(attached, 'utf8'), 'not really a png');
check('  lands beside the queue', attached.startsWith(q.attachmentsDir(CWD)), true);
check('  name is filesystem-safe', /\d{14}-shop_tabs\.png$/.test(attached), true);

// The original may be deleted the moment the message is sent.
fs.rmSync(srcDir, { recursive: true, force: true });
check('survives the original being removed', fs.existsSync(attached), true);

// Two files of the same name must not collide.
fs.mkdirSync(srcDir, { recursive: true });
fs.writeFileSync(shot, 'second one');
const second = q.attach(CWD, shot);
check('a same-named file does not overwrite', second === attached, false);
check('  and both still exist', fs.existsSync(attached) && fs.existsSync(second), true);

check('attaching a missing file is refused', q.attach(CWD, path.join(CWD, 'nope.png')), null);
check('attaching a directory is refused', q.attach(CWD, srcDir), null);
check('attach via CLI exits non-zero on a bad path',
  cli('attach', path.join(CWD, 'nope.png')).code, 1);
fs.rmSync(srcDir, { recursive: true, force: true });
fs.rmSync(q.attachmentsDir(CWD), { recursive: true, force: true });

// ---------------------------------------------------------------- wrap-up

q.clear(CWD);
q.add(CWD, 'the only task');
JSON.parse(stop({ last_assistant_message: 'w1' })); // deliver it
const wrap = JSON.parse(stop({ last_assistant_message: 'w2' }));
check('an emptied queue asks what should follow',
  wrap.reason.includes('The queue is now empty'), true);
check('  and permits an empty answer',
  wrap.reason.includes('Do NOT invent work'), true);
check('  offering the --wrapup flag', wrap.reason.includes('--wrapup'), true);

// Exactly once: a second stop with nothing new must let Claude finish.
check('it does not ask twice', stop({ last_assistant_message: 'w3' }), '{}');

// Follow-ups a wrap-up produced must not trigger another wrap-up, or the
// queue could grow indefinitely overnight.
q.add(CWD, 'follow-up work', { fromWrapUp: true });
JSON.parse(stop({ last_assistant_message: 'w4' })); // deliver the follow-up
check('a wrap-up follow-up does not re-arm it', stop({ last_assistant_message: 'w5' }), '{}');

// Ordinary work does re-arm it, so the next real run gets its own wrap-up.
q.add(CWD, 'genuinely new work');
JSON.parse(stop({ last_assistant_message: 'w6' }));
check('ordinary work re-arms it',
  JSON.parse(stop({ last_assistant_message: 'w7' })).reason.includes('queue is now empty'), true);

// An empty queue that never ran must stay silent.
q.clear(CWD);
check('no run, no wrap-up', stop({ last_assistant_message: 'w8' }), '{}');

// The --wrapup flag must survive the CLI.
q.clear(CWD);
spawnSync(process.execPath, [HOOK, 'add', 'from a wrap-up', '--wrapup'], { cwd: CWD });
check('--wrapup marks the item', q.load(CWD).items[0].fromWrapUp, true);
check('  and is not part of the text', q.load(CWD).items[0].text, 'from a wrap-up');
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

// Starting a run via the CLI means it came through the busy path, which never
// sees the enqueue hook — so the watcher must be requested here instead.
const firstAdd = cli('add', 'alpha');
check('first CLI add asks for the watcher', firstAdd.out.includes('ACTION REQUIRED'), true);
check('  with the watch command', firstAdd.out.includes('watch "'), true);
check('later adds do not ask again', cli('add', 'beta').out.includes('ACTION REQUIRED'), false);

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

// An item is popped before it is handed to Claude, so a turn that dies to a
// rate limit or an interrupt takes its task with it. requeue-last puts it back.
q.clear(CWD);
check('nothing to requeue on a fresh queue', cli('requeue-last').out.includes('Nothing to requeue'), true);

q.add(CWD, 'survivor');
let interrupted = q.load(CWD);
interrupted.lastItem = 'the task that died mid-run';
q.save(CWD, interrupted);
cli('requeue-last');
check('requeues to the FRONT', q.load(CWD).items[0].text, 'the task that died mid-run');
check('  without disturbing the rest', q.load(CWD).items[1].text, 'survivor');
check('  flagged as resumed', q.load(CWD).items[0].resumed, true);
check('  and shown as such', cli('list').out.includes('[resumed]'), true);

// The flag must survive until delivery, however much later that is, and change
// the instruction so the work is not blindly redone.
const resumedDelivery = JSON.parse(stop({ last_assistant_message: 'rR' }));
check('a resumed task says it was interrupted',
  resumedDelivery.reason.includes('INTERRUPTED partway through'), true);
check('  and says to check current state first',
  resumedDelivery.reason.includes('git diff'), true);
check('  while still carrying the task itself',
  resumedDelivery.reason.includes('the task that died mid-run'), true);

// A normal task must not carry the note.
const normalDelivery = JSON.parse(stop({ last_assistant_message: 'rN' }));
check('a normal task has no resumed note',
  normalDelivery.reason.includes('INTERRUPTED'), false);

q.clear(CWD);
q.add(CWD, 'survivor');
interrupted = q.load(CWD);
interrupted.lastItem = 'the task that died mid-run';
q.save(CWD, interrupted);
cli('requeue-last');
check('  and refuses to double-add', cli('requeue-last').out.includes('Already at the front'), true);
check('  so the queue is unchanged', q.load(CWD).items.length, 2);

q.clear(CWD);
cli('add', 'alpha');
cli('add', 'beta');
cli('add', 'gamma');
cli('remove', '1');
check('remove drops one', q.load(CWD).items.length, 2);
cli('pause');
check('pause sets the flag', q.load(CWD).paused, true);
cli('resume');
check('resume clears it', q.load(CWD).paused, false);
cli('clear');
check('clear empties', q.load(CWD).items.length, 0);
check('unknown command exits non-zero', cli('flibble').code, 1);

// ---------------------------------------------------------------- watch

function watchOnce(extraArgs = []) {
  // Runs one tick then exits via the quiet path, so the startup output can be
  // asserted without leaving a process behind.
  const r = spawnSync(process.execPath, [HOOK, 'watch', CWD, ...extraArgs], {
    encoding: 'utf8',
    timeout: 4000,
  });
  return r.stdout;
}

q.clear(CWD);
q.clearParked(CWD);
try {
  fs.unlinkSync(path.join(q.stateDir(CWD), 'watch.lock'));
} catch {
  /* none */
}

// A parked task is a question waiting on the user, and it is otherwise silent:
// the run carries on without it, so nothing prompts them to look.
q.park(CWD, 'the withered plant rule', 'which of the three options do you want?');
const started = watchOnce();
check('watch surfaces parked tasks at startup',
  started.includes('awaiting your decision'), true);
check('  and names the task', started.includes('the withered plant rule'), true);
check('  and what it needs', started.includes('which of the three options'), true);
q.clearParked(CWD);

// ---------------------------------------------------------------- statusline

function statusline(dir = CWD) {
  const r = spawnSync(process.execPath, [HOOK, 'statusline'], {
    input: JSON.stringify({ workspace: { current_dir: dir } }),
    encoding: 'utf8',
  });
  return r.stdout.replace(/\x1b\[[0-9;]*m/g, ''); // strip ANSI for assertions
}

q.clear(CWD);
q.clearParked(CWD);
check('empty queue prints nothing at all', statusline(), '');

q.add(CWD, 'fix the header alignment');
q.add(CWD, 'write the tests');

// Queued but not started: a progress fraction would imply it was still moving.
check('waiting queue says it needs a nudge',
  statusline().includes('2 waiting') && statusline().includes('send any message'), true);

// consecutiveBlocks doubles as "delivered this run", so the total grows with it.
let s = q.load(CWD);
s.consecutiveBlocks = 3;
s.lastPopAt = Date.now() - 4 * 60 * 1000;
q.save(CWD, s);
check('running queue shows progress', statusline().includes('3/5'), true);
check('  and what is up next', statusline().includes('next: fix the header'), true);

// Stale run (e.g. restarted hours ago) goes back to the nudge form.
s = q.load(CWD);
s.lastPopAt = Date.now() - 3 * 60 * 60 * 1000;
q.save(CWD, s);
check('stale run says it needs a nudge', statusline().includes('2 waiting'), true);
s.lastPopAt = Date.now() - 4 * 60 * 1000;
q.save(CWD, s);
check('shows time since the last delivery', statusline().includes('4m'), true);

q.setPaused(CWD, true);
check('paused is called out', statusline().includes('paused'), true);
check('  and hides next-item detail', statusline().includes('next:'), false);
q.setPaused(CWD, false);

// The queue empties before the last item finishes — the longest unattended
// stretch of a run, and the worst moment to show nothing.
q.save(CWD, {
  ...q.emptyState(),
  consecutiveBlocks: 4,
  lastPopAt: Date.now() - 6 * 60 * 1000,
  lastItem: 'rename the project everywhere',
});
check('last item running is still reported', statusline().includes('4/4'), true);
check('  with elapsed time', statusline().includes('6m'), true);
check('  and names what is running', statusline().includes('now: rename the project'), true);

// Once that run goes stale, fall silent again.
q.save(CWD, { ...q.emptyState(), consecutiveBlocks: 4, lastPopAt: Date.now() - 3 * 60 * 60 * 1000 });
check('finished run prints nothing', statusline(), '');

q.clear(CWD);
q.park(CWD, 'blocked thing', 'which database?');
check('parked shows even with an empty queue', statusline().includes('1 parked'), true);
q.clearParked(CWD);

check('unknown project prints nothing', statusline(path.join(CWD, 'nope')), '');

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

// Items merely WAITING is not a run. A queue can sit pending for hours — after
// a restart, or queued then left — and that session is an ordinary chat that
// must keep its ability to ask questions.
q.add(CWD, 'a queued task');
check('queue pending but never started: questions still allowed',
  pretool('AskUserQuestion'), '');

// A delivery is what starts a run.
let running = q.load(CWD);
running.consecutiveBlocks = 1;
running.lastPopAt = Date.now();
q.save(CWD, running);

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

// Restart mid-run: items survive, but the run is over until something is
// delivered again — the session must not be left unable to ask questions.
q.save(CWD, {
  ...q.emptyState(),
  items: [{ id: 'x', text: 'left over from before the restart' }],
  consecutiveBlocks: 4,
  lastPopAt: Date.now() - 3 * 60 * 60 * 1000,
});
check('restart with items pending: questions allowed', pretool('AskUserQuestion'), '');
check('  and the items are still there', q.load(CWD).items.length, 1);

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
