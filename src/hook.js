#!/usr/bin/env node
/*
 * ClaudeQue Stop hook.
 *
 * Claude Code's built-in queue flushes at the next LLM pause — between tool
 * calls, after a subagent returns — so a batch of prompts lands mid-task. The
 * Stop hook fires only at true end-of-turn, so releasing one prompt per fire
 * gives strict one-at-a-time delivery.
 *
 * Hook mode (invoked by Claude Code, hook JSON on stdin):
 *   node src/hook.js stop
 *
 * CLI (acts on the queue for the current directory):
 *   node src/hook.js add "text" | list | edit <n> "text" | move <n> <up|down>
 *   node src/hook.js remove <n> | pause | resume | clear | parked | unpark
 */

const crypto = require('crypto');
const q = require('./queue');

/*
 * Queued tasks run unattended, so the user is not there to answer anything.
 * A clarifying question ends the turn — the queue then moves on and the task is
 * left half-done. So the instruction is: decide and proceed, or park it.
 */
const PREFIX =
  'New queued task from the user (unrelated to the work above). ' +
  'Treat this as a fresh request and start it now.\n\n' +
  'IMPORTANT — this task came from a queue and is running unattended. ' +
  'The user is not watching and cannot answer questions.\n' +
  '- Do NOT ask clarifying questions. Choose the most reasonable ' +
  'interpretation, proceed, and state the assumption you made.\n' +
  '- Do NOT stop to request approval for an approach. Pick one.\n' +
  '- Only if the task is genuinely impossible without an answer ' +
  '(missing credentials, a destructive choice with no safe default), park it:\n' +
  `    node "${__filename.replace(/\\/g, '/')}" park "<the task>" "<what you need to know>"\n` +
  '  then say one line about parking it and stop. The remaining queue continues, ' +
  'and the user reviews parked tasks at the end.\n\n' +
  'The task:\n\n';

/*
 * Two settings files defining the same hook fire milliseconds apart.
 * Overridable so tests can exercise the window boundary.
 *
 * Known edge: if Claude produces a byte-identical reply for two queue items
 * within this window, the second pop is suppressed and the queue waits a turn.
 * A one-turn delay beats the alternative — silently eating a prompt.
 */
const DUPLICATE_WINDOW_MS = Number(process.env.CLAUDEQUE_DEDUPE_MS) || 2000;

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

/*
 * Only JSON may go to stdout — anything else corrupts the hook response.
 *
 * Never process.exit() here: it tears the process down before an async stdout
 * pipe has flushed, silently truncating the response. Set exitCode and let Node
 * drain. THROWN_EXIT unwinds so callers can treat emit() as terminal.
 */
const THROWN_EXIT = Symbol('emit');

function emit(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj));
  process.exitCode = 0;
  throw THROWN_EXIT;
}

/*
 * `block` is the hook API's word for "do not stop yet" — it blocks the stop,
 * not the prompt, and `reason` becomes Claude's next instruction.
 */
function injection(text) {
  return { decision: 'block', reason: PREFIX + text };
}

function preview(text, n = 60) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n) + '…' : oneLine;
}

// ---------------------------------------------------------------- hook

/* que: / queue: / next: / q: — must start the message (or a later line). */
const QUEUE_TRIGGER = /^(?:que|queue|next|q):[ \t]*/i;
const QUEUE_TRIGGER_LINE = /^[ \t]*(?:que|queue|next|q):[ \t]*/i;

/*
 * Split a queue command into items. A message is normally ONE item, so that
 * multi-line prompts survive whole:
 *
 *   que: fix the header
 *        - keep it centred          -> one item, both lines
 *
 * But repeating the prefix on later lines is an obvious way to queue several,
 * so each line that starts with a trigger begins a new item:
 *
 *   que: something 1
 *   que: something 2                -> two items
 */
function splitItems(prompt) {
  const items = [];
  let current = null;

  for (const line of prompt.split('\n')) {
    const match = line.match(QUEUE_TRIGGER_LINE);
    if (match) {
      if (current !== null) items.push(current);
      current = line.slice(match[0].length);
    } else if (current !== null) {
      current += '\n' + line;
    }
  }
  if (current !== null) items.push(current);

  return items.map((t) => t.trim()).filter(Boolean);
}

function handleEnqueue(payload, cwd) {
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  const match = prompt.match(QUEUE_TRIGGER);

  /*
   * Log every invocation, not just matches. A silent no-match and the hook
   * never firing look identical otherwise — and whether this fires for
   * messages sent while Claude is BUSY is the whole question.
   */
  q.log(cwd, {
    event: 'enqueue-seen',
    session: payload.session_id,
    promptLen: prompt.length,
    head: prompt.slice(0, 40),
    matched: !!match,
  });

  if (!match) emit(null); // not a queue command — let it through untouched

  const texts = splitItems(prompt);
  if (!texts.length) emit(null);

  for (const text of texts) q.add(cwd, text);
  const n = q.load(cwd).items.length;

  q.log(cwd, {
    event: 'enqueue',
    session: payload.session_id,
    added: texts.length,
    queueLen: n,
  });

  /*
   * Deliberately do NOT block the prompt.
   *
   * Blocking meant no turn ever started, and the queue only advances when a
   * turn ENDS — so queueing while Claude was idle parked the queue until the
   * user sent another message. Letting the prompt through costs one trivial
   * acknowledgement turn, and the end of that turn is what kicks the queue off.
   *
   * additionalContext tells Claude the task is already queued and must not be
   * performed now; the Stop hook delivers it a moment later.
   */
  emit({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext:
        `[ClaudeQue] This message is a queue command. ` +
        `${texts.length === 1 ? 'The task has' : `${texts.length} tasks have`} ALREADY been ` +
        `added to the queue (${n} waiting) — do NOT do ${texts.length === 1 ? 'it' : 'them'} now, ` +
        `and do not restate ${texts.length === 1 ? 'it' : 'them'}. Reply with exactly one short ` +
        `line, e.g. "Queued — ${n} waiting.", then stop. The Stop hook will deliver queued items ` +
        `one at a time, starting as soon as this turn ends.`,
    },
  });
}

/* How long after the last delivery a run still counts as in progress. */
const RUN_ACTIVE_MS = 10 * 60 * 1000;

function queueIsRunning(state) {
  if (state.paused) return false;
  if (state.items.length > 0) return true;
  // The final item is still executing after the queue emptied.
  return (
    state.consecutiveBlocks > 0 &&
    Date.now() - (state.lastPopAt || 0) < RUN_ACTIVE_MS
  );
}

/*
 * Tools that stall a queue by design: they render a dialog and wait for a
 * human. The turn stays open, so no Stop hook fires and everything behind it
 * freezes — and bypassPermissions does not help, since it approves the tool
 * *running*, and running it means waiting.
 */
const BLOCKING_TOOLS = new Set(['AskUserQuestion']);

/*
 * Only interferes with the tools that stall a queue. Everything else defers to
 * the normal permission flow — whatever gate the session already has stays
 * exactly as it is.
 */
function handlePreTool(payload, cwd) {
  if (!BLOCKING_TOOLS.has(payload.tool_name)) emit(null);

  const state = q.load(cwd);
  if (!queueIsRunning(state)) emit(null); // not a queued run — leave it alone

  q.log(cwd, {
    event: 'deny-question',
    session: payload.session_id,
    tool: payload.tool_name,
    input: preview(JSON.stringify(payload.tool_input || {}), 300),
    queueLen: state.items.length,
  });

  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'ClaudeQue: this task is running unattended from a queue — nobody is ' +
        'there to answer, and waiting would freeze every task behind it. ' +
        'Do not ask. Choose the most reasonable option, proceed, and state the ' +
        'assumption you made. If the task is genuinely impossible without an ' +
        'answer, park it instead:\n' +
        `  node "${__filename.replace(/\\/g, '/')}" park "<the task>" "<what you need to know>"\n` +
        'then say one line about parking it and stop, so the rest of the queue continues.',
    },
  });
}

function handleStop(payload, cwd) {
  const state = q.load(cwd);
  const before = state.items.length;

  /*
   * Idempotency guard. Hooks defined in more than one settings file all fire,
   * so one turn-end can invoke this twice, consuming two prompts.
   *
   * Do NOT key on prompt_id alone: injected prompts continue the SAME turn, so
   * prompt_id is stable across an entire queued run and every legitimate
   * follow-up would look like a duplicate. Key on the assistant message that
   * triggered this stop — that differs per iteration — and only suppress fires
   * landing within the window, since true double-fires are milliseconds apart.
   */
  const turnKey = sha1(
    `${payload.prompt_id || ''}::${payload.last_assistant_message || ''}`
  );
  const sinceLast = Date.now() - (state.lastPopAt || 0);
  if (turnKey === state.lastTurnKey && sinceLast < DUPLICATE_WINDOW_MS) {
    q.log(cwd, {
      event: 'stop',
      session: payload.session_id,
      action: 'duplicate-invocation',
      sinceLastMs: sinceLast,
      queueLen: before,
    });
    emit({});
  }

  if (state.paused || before === 0) {
    q.log(cwd, {
      event: 'stop',
      session: payload.session_id,
      stop_hook_active: payload.stop_hook_active,
      queueLen: before,
      action: state.paused ? 'paused' : 'empty',
      consecutiveBlocks: state.consecutiveBlocks,
    });
    state.consecutiveBlocks = 0;
    q.save(cwd, state);
    emit({}); // let Claude stop normally
  }

  const item = state.items.shift();
  state.consecutiveBlocks += 1;
  state.lastTurnKey = turnKey;
  state.lastPopAt = Date.now();
  q.save(cwd, state);

  q.log(cwd, {
    event: 'stop',
    session: payload.session_id,
    stop_hook_active: payload.stop_hook_active,
    queueLenBefore: before,
    queueLenAfter: state.items.length,
    consecutiveBlocks: state.consecutiveBlocks,
    injected: preview(item.text),
  });

  emit(injection(item.text));
}

// ---------------------------------------------------------------- statusline

/*
 * Renders queue progress in Claude Code's status line, so a long run is
 * visible without opening a terminal.
 *
 * `consecutiveBlocks` doubles as the count delivered in the current run: it
 * increments on every pop and resets when the queue empties, so done + waiting
 * gives the run total without storing it separately.
 */
const DIM = '\x1b[2m';
const ORANGE = '\x1b[38;5;209m';
const RED = '\x1b[38;5;167m';
const RESET = '\x1b[0m';

function ago(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
}

function handleStatusline(payload) {
  const cwd = (payload.workspace && payload.workspace.current_dir) || payload.cwd;
  if (!cwd) return;

  const state = q.load(cwd);
  const waiting = state.items.length;
  const parked = q.loadParked(cwd).length;

  // Nothing to report — stay out of the way entirely.
  if (!waiting && !parked) return;

  const parts = [];

  if (state.paused) {
    parts.push(`${RED}⏸ ${waiting} queued (paused)${RESET}`);
  } else if (waiting) {
    const done = state.consecutiveBlocks || 0;
    const total = done + waiting;
    parts.push(`${ORANGE}⏳ ${done}/${total}${RESET}`);

    if (state.lastPopAt) parts.push(`${DIM}${ago(Date.now() - state.lastPopAt)}${RESET}`);

    // What is running right now is the item popped last, which is no longer in
    // the queue — so show what is up next instead, which is in it.
    parts.push(`${DIM}next: ${preview(state.items[0].text, 45)}${RESET}`);
  }

  if (parked) parts.push(`${RED}⚑ ${parked} parked${RESET}`);

  process.stdout.write(parts.join(` ${DIM}·${RESET} `));
}

// ---------------------------------------------------------------- cli

function handleCli(mode, cwd, argv) {
  const state = q.load(cwd);

  if (mode === 'list') {
    if (!state.items.length) {
      console.log('Queue is empty.');
    } else {
      state.items.forEach((it, i) =>
        console.log(`${String(i + 1).padStart(2)}. ${preview(it.text, 100)}`)
      );
      console.log(`\n${state.items.length} queued.`);
    }
    if (state.paused) console.log('(queue is PAUSED)');
    return;
  }

  if (mode === 'clear') {
    q.clear(cwd);
    console.log('Queue cleared.');
    return;
  }

  if (mode === 'park') {
    const item = q.park(cwd, argv[3], argv[4]);
    if (!item) {
      console.error('Usage: node src/hook.js park "<task>" "<what you need to know>"');
      process.exitCode = 1;
      return;
    }
    console.log(`Parked: ${preview(item.text)}`);
    console.log(`Needs:  ${item.reason}`);
    return;
  }

  if (mode === 'parked') {
    const items = q.loadParked(cwd);
    if (!items.length) {
      console.log('Nothing parked.');
      return;
    }
    items.forEach((it, i) => {
      console.log(`${String(i + 1).padStart(2)}. ${preview(it.text, 90)}`);
      console.log(`    needs: ${it.reason}`);
    });
    console.log(`\n${items.length} parked. Clear with: node src/hook.js unpark`);
    return;
  }

  if (mode === 'unpark') {
    const n = q.loadParked(cwd).length;
    q.clearParked(cwd);
    console.log(`Cleared ${n} parked task${n === 1 ? '' : 's'}.`);
    return;
  }

  if (mode === 'pause' || mode === 'resume') {
    const paused = q.setPaused(cwd, mode === 'pause');
    console.log(
      paused
        ? `Queue PAUSED (${state.items.length} held).`
        : `Queue resumed (${state.items.length} queued).`
    );
    return;
  }

  if (mode === 'remove') {
    const n = Number(argv[3]);
    if (!Number.isInteger(n) || n < 1 || n > state.items.length) {
      console.error(`Usage: node src/hook.js remove <1-${state.items.length}>`);
      process.exitCode = 1;
      return;
    }
    const target = state.items[n - 1];
    q.remove(cwd, target.id);
    console.log(`Removed #${n}: ${preview(target.text)}`);
    return;
  }

  if (mode === 'edit') {
    const n = Number(argv[3]);
    const text = argv.slice(4).join(' ');
    if (!Number.isInteger(n) || n < 1 || n > state.items.length || !text.trim()) {
      console.error(`Usage: node src/hook.js edit <1-${state.items.length}> "new text"`);
      process.exitCode = 1;
      return;
    }
    q.update(cwd, state.items[n - 1].id, text);
    console.log(`Updated #${n}: ${preview(text)}`);
    return;
  }

  if (mode === 'move') {
    const n = Number(argv[3]);
    const dir = String(argv[4] || '').toLowerCase();
    const delta = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
    if (!Number.isInteger(n) || !delta || !q.move(cwd, (state.items[n - 1] || {}).id, delta)) {
      console.error(`Usage: node src/hook.js move <1-${state.items.length}> <up|down>`);
      process.exitCode = 1;
      return;
    }
    console.log(`Moved #${n} ${dir}.`);
    return;
  }

  if (mode === 'add') {
    const text = argv.slice(3).join(' ').trim();
    if (!text) {
      console.error('Usage: node src/hook.js add "prompt text"');
      process.exitCode = 1;
      return;
    }
    q.add(cwd, text);
    console.log(`Queued #${state.items.length + 1}: ${preview(text)}`);
    return;
  }

  console.error(`Unknown command: ${mode}`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------- entry

function main() {
  const mode = process.argv[2];

  const cliModes = ['add', 'list', 'clear', 'pause', 'resume', 'remove',
    'edit', 'move', 'park', 'parked', 'unpark'];
  const hookModes = ['stop', 'enqueue', 'pretool', 'statusline'];

  if (cliModes.includes(mode)) {
    handleCli(mode, process.cwd(), process.argv);
    return;
  }

  /*
   * Reject anything unrecognised here rather than falling through to the hook
   * path, where it would wait on stdin, find nothing, and exit 0 — making a
   * mistyped command look like it worked.
   */
  if (!hookModes.includes(mode)) {
    console.error(
      `Unknown command: ${mode || '(none)'}\n\n` +
        `Queue:  ${cliModes.join(' | ')}\n` +
        `Hooks:  ${hookModes.join(' | ')}  (invoked by Claude Code, not by hand)`
    );
    process.exitCode = 1;
    return;
  }

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    let cwd = process.cwd();
    try {
      // Strip a UTF-8 BOM: some shells prepend one when piping.
      const payload = JSON.parse(raw.replace(/^﻿/, '').trim());
      cwd = payload.cwd || cwd;
      if (mode === 'stop') handleStop(payload, cwd);
      else if (mode === 'enqueue') handleEnqueue(payload, cwd);
      else if (mode === 'statusline') handleStatusline(payload);
      else handlePreTool(payload, cwd);
    } catch (err) {
      if (err === THROWN_EXIT) return; // normal termination
      // Anything else, malformed input included, must not break the session.
      q.log(cwd, {
        event: 'error',
        mode,
        message: String((err && err.message) || err),
        rawPreview: raw.slice(0, 200),
      });
      process.exitCode = 0;
    }
  });
}

main();
