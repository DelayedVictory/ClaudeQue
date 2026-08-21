#!/usr/bin/env node
/*
 * Sleep the PC once every live Claude Code session has finished its queue and
 * gone quiet.
 *
 *   node src/sleep-when-idle.js [--minutes N] [--dry-run]
 *
 * "Queue empty" is not the same as "finished": an item is popped BEFORE it is
 * handed to Claude, so a queue reads 0 while the last task is still running.
 * A session therefore counts as done only when its queue is empty AND its
 * transcript has been silent for a while — the transcript is appended on every
 * message and tool result, so silence is a reasonable proxy for idle.
 *
 * Observed on a real run: sessions went quiet for 8-15 minutes and then
 * resumed (a wrap-up firing, or a long tool call writing nothing). Hence a
 * generous default window and a requirement for two consecutive clean polls
 * before doing something as irreversible as powering the machine down.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const q = require('./queue');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const IDLE_MINUTES = Number(
  (args[args.indexOf('--minutes') + 1] || '').match(/^\d+$/)
    ? args[args.indexOf('--minutes') + 1]
    : 15
);

const POLL_MS = 30_000;
const CLEAN_POLLS_REQUIRED = 2;
const COUNTDOWN_SECONDS = 60;

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const stamp = () => new Date().toTimeString().slice(0, 8);

/* Live sessions, discovered fresh each poll — they come and go. */
function liveSessions() {
  try {
    return [
      ...new Set(
        fs
          .readdirSync(SESSIONS_DIR)
          .filter((f) => f.endsWith('.json'))
          .map((f) => {
            try {
              return JSON.parse(
                fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')
              ).cwd;
            } catch {
              return null;
            }
          })
          .filter(Boolean)
      ),
    ];
  } catch {
    return [];
  }
}

/*
 * Claude Code encodes a project path into a transcript directory name by
 * replacing : \ / and . with a dash. The dot matters — without it, worktree
 * paths under .claude never resolve and the session looks permanently idle.
 */
function idleMinutes(cwd) {
  const dir = path.join(
    os.homedir(),
    '.claude',
    'projects',
    cwd.replace(/[:\\/.]/g, '-')
  );
  let newest = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const t = fs.statSync(path.join(dir, f)).mtimeMs;
      if (t > newest) newest = t;
    }
  } catch {
    return Infinity;
  }
  return newest ? (Date.now() - newest) / 60000 : Infinity;
}

function statusOf(cwd) {
  const state = q.load(cwd);
  const waiting = state.items.length;
  const idle = idleMinutes(cwd);
  const name = path.basename(cwd);

  // A paused queue with work in it will never drain on its own. Sleeping would
  // strand it, so treat it as a blocker and say why rather than waiting mutely.
  if (state.paused && waiting) {
    return { name, done: false, blocked: true, label: `PAUSED, ${waiting} held` };
  }
  if (waiting) return { name, done: false, label: `${waiting} queued` };
  if (idle < IDLE_MINUTES) {
    return { name, done: false, label: `working (${idle.toFixed(0)}m quiet)` };
  }
  return { name, done: true, label: 'idle' };
}

/*
 * A queue with no live session cannot drain, so sleeping would strand it.
 * Only checks the parent repo of a live worktree session — the common case
 * where work is queued against the repo while the session runs in a worktree.
 * Scanning the whole disk would cost more than it is worth.
 */
function orphanQueues(liveCwds) {
  const live = new Set(liveCwds);
  const roots = new Set(
    liveCwds
      .map((cwd) => cwd.split(/[\\/]\.claude[\\/]worktrees[\\/]/)[0])
      .filter((root) => !live.has(root))
  );

  return [...roots]
    .map((cwd) => ({ cwd, n: q.load(cwd).items.length }))
    .filter((o) => o.n > 0);
}

function sleepPc() {
  // If hibernation is enabled Windows hibernates instead of sleeping; either
  // way the machine powers down.
  execFile('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], (err) => {
    if (err) console.log(`Sleep command failed: ${err.message}`);
  });
}

// ---------------------------------------------------------------- main

console.log('ClaudeQue - sleep when idle');
console.log(
  `Sleeping once every live session has an empty queue and has been quiet ` +
    `for ${IDLE_MINUTES} minutes${DRY_RUN ? ' (DRY RUN - will not sleep)' : ''}.`
);
console.log('Close this window or press Ctrl+C to cancel.\n');

let cleanPolls = 0;
let lastLine = '';

function tick() {
  const live = liveSessions();

  if (!live.length) {
    console.log(`[${stamp()}] No Claude Code sessions running.`);
  }

  const results = live.map(statusOf);
  const orphans = orphanQueues(live);
  const line =
    results.map((r) => `${r.name}: ${r.label}`).join(' | ') +
    orphans.map((o) => ` | ${path.basename(o.cwd)}: ${o.n} queued, NO SESSION`).join('');

  if (line !== lastLine) {
    lastLine = line;
    if (line.trim()) console.log(`[${stamp()}] ${line}`);
  }

  const blocked = results.some((r) => r.blocked) || orphans.length;
  const allDone = results.every((r) => r.done);

  if (blocked || !allDone) {
    cleanPolls = 0;
    return;
  }

  cleanPolls += 1;
  if (cleanPolls < CLEAN_POLLS_REQUIRED) {
    console.log(`[${stamp()}] All idle (${cleanPolls}/${CLEAN_POLLS_REQUIRED} confirmations)`);
    return;
  }

  clearInterval(timer);
  console.log(`\n[${stamp()}] Everything is finished.`);

  if (DRY_RUN) {
    console.log('Dry run - not sleeping.');
    return;
  }

  console.log(`Sleeping in ${COUNTDOWN_SECONDS}s. Press Ctrl+C to cancel.`);
  let left = COUNTDOWN_SECONDS;
  const countdown = setInterval(() => {
    left -= 10;
    if (left > 0) {
      console.log(`  ${left}s...`);
      return;
    }
    clearInterval(countdown);
    console.log('Sleeping now.');
    sleepPc();
  }, 10_000);
}

const timer = setInterval(tick, POLL_MS);
tick();
