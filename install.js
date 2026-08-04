#!/usr/bin/env node
/*
 * ClaudeQue installer.
 *
 *   node install.js      register the hooks and the busy-path rule
 *   node install.js --uninstall
 *
 * Everything is keyed off this file's own location, so the repo can live
 * anywhere. Both edits are merge-in-place and idempotent: existing hooks and
 * CLAUDE.md content are preserved, and re-running just refreshes our entries.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = __dirname;
const HOOK = path.join(REPO, 'src', 'hook.js').replace(/\\/g, '/');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const CLAUDE_MD = path.join(CLAUDE_DIR, 'CLAUDE.md');

const MARKER = 'ClaudeQue'; // identifies our entries on re-run and uninstall
const BEGIN = '<!-- BEGIN ClaudeQue -->';
const END = '<!-- END ClaudeQue -->';

const uninstalling = process.argv.includes('--uninstall');
// Terminal CLI only — the desktop app ignores statusLine entirely.
const wantStatusLine = process.argv.includes('--statusline');

// ---------------------------------------------------------------- helpers

function readJson(file) {
  try {
    // Strip a UTF-8 BOM: PowerShell and several Windows editors add one.
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    // A settings file we cannot parse must never be overwritten — that would
    // silently destroy the user's other hooks and permissions.
    throw new Error(
      `${file} exists but is not valid JSON (${err.message}).\n` +
        `Fix or move it, then re-run. Nothing has been changed.`
    );
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/*
 * Recognise our own entries so re-running replaces rather than duplicates them.
 * Match on a command that invokes a ClaudeQue hook.js — case-insensitively,
 * since the install path's casing varies — rather than on the marker alone, so
 * an unrelated hook that merely mentions ClaudeQue is never removed.
 */
function isOurs(entry) {
  const commands = (entry.hooks || []).map((h) => String(h.command || ''));
  return commands.some(
    (c) => /hook\.js"?\s+(enqueue|stop|pretool)\b/i.test(c) && /claudeque/i.test(c)
  );
}

function hookEntry(mode, statusMessage) {
  return {
    hooks: [
      {
        type: 'command',
        command: `node "${HOOK}" ${mode}`,
        timeout: 10,
        statusMessage,
      },
    ],
  };
}

// ---------------------------------------------------------------- settings

function updateSettings() {
  const settings = readJson(SETTINGS) || {};
  settings.hooks = settings.hooks || {};

  const events = ['UserPromptSubmit', 'Stop', 'PreToolUse'];

  for (const event of events) {
    settings.hooks[event] = (settings.hooks[event] || []).filter((e) => !isOurs(e));
  }

  if (!uninstalling) {
    settings.hooks.UserPromptSubmit.push(
      hookEntry('enqueue', 'ClaudeQue: checking for queue command...')
    );
    settings.hooks.Stop.push(
      hookEntry('stop', 'ClaudeQue: pulling next queued prompt...')
    );
    // Denies AskUserQuestion while a queue is draining: that tool waits for a
    // human, so the turn never ends and every task behind it freezes.
    settings.hooks.PreToolUse.push(
      hookEntry('pretool', 'ClaudeQue: queued run, no questions...')
    );
  }

  // Drop keys we emptied, so an uninstall leaves no debris.
  for (const event of events) {
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;

  const statusLine = updateStatusLine(settings);

  writeJson(SETTINGS, settings);
  return statusLine;
}

// ---------------------------------------------------------------- statusline

/*
 * The status line is NOT installed by default: the Claude Code desktop app
 * never invokes `statusLine` at all — verified by logging every invocation and
 * seeing none across 25s with a 10s refresh configured. It works in the
 * terminal CLI, so `--statusline` opts in.
 *
 * `statusLine` is a single field rather than a list, so writing it blindly
 * would replace whatever the user already had; only ever set it when absent or
 * already ours.
 */
function updateStatusLine(settings) {
  const current = settings.statusLine;
  const isOurs = current && /claudeque/i.test(JSON.stringify(current));

  if (uninstalling || !wantStatusLine) {
    if (isOurs) delete settings.statusLine;
    return isOurs ? 'removed' : uninstalling ? 'left alone' : 'not installed (--statusline to opt in)';
  }

  if (current && !isOurs) return 'skipped (you already have one)';

  settings.statusLine = {
    type: 'command',
    command: `node "${HOOK}" statusline`,
    refreshInterval: 10,
    padding: 0,
  };
  return 'installed';
}

// ---------------------------------------------------------------- CLAUDE.md

/*
 * The busy-path rule. Messages typed while Claude is working are steering
 * messages that bypass hooks entirely, so Claude has to handle that case
 * itself — see README.
 */
function ruleText() {
  return `${BEGIN}
# Queued prompts (ClaudeQue)

If a user message begins with \`que:\`, \`queue:\`, \`next:\`, or \`q:\`, it is **not a
request to act on**. It is a task being added to a queue for later.

Do this instead:

1. Run, from the session's working directory:
   \`node "${HOOK}" add "<everything after the colon>"\`
2. If that command prints **ACTION REQUIRED**, do exactly what it says — start
   the watcher as a background task (\`run_in_background: true\`) so the user can
   follow the run in the background-tasks panel. Do not wait for it or report
   its output.
3. Reply with one short line — e.g. \`Queued (3 waiting).\`
4. **Continue whatever you were doing**, as if the message had not arrived. Do
   not change plans, do not start the queued task, do not ask about it.

A \`Stop\` hook delivers queued items one at a time once the current turn ends.

A \`UserPromptSubmit\` hook already intercepts these messages — but only when
Claude is **idle**. Messages typed while Claude is *working* bypass hooks and
land mid-turn, which is exactly when a queued task must not derail the current
one. So: **if you are seeing a \`que:\` message, this rule applies.**

Never treat a \`que:\` message as an instruction about the current task, however
relevant it looks. Queue it and carry on.
${END}`;
}

function updateClaudeMd() {
  let body = '';
  try {
    body = fs.readFileSync(CLAUDE_MD, 'utf8');
  } catch {
    /* no file yet */
  }

  // Remove any previous block, leaving the user's own content untouched.
  const stripped = body
    .replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`, 'g'), '')
    .trimEnd();

  const next = uninstalling
    ? stripped
    : (stripped ? stripped + '\n\n' : '') + ruleText();

  if (!next.trim()) {
    try {
      fs.unlinkSync(CLAUDE_MD);
    } catch {
      /* nothing to remove */
    }
    return null;
  }

  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(CLAUDE_MD, next + '\n', 'utf8');
  return CLAUDE_MD;
}

// ---------------------------------------------------------------- main

try {
  const statusLine = updateSettings();
  const mdPath = updateClaudeMd();

  if (uninstalling) {
    console.log('ClaudeQue uninstalled.');
    console.log(`  hooks removed from  ${SETTINGS}`);
    console.log(`  status line         ${statusLine}`);
    if (mdPath) console.log(`  rule removed from   ${mdPath}`);
    console.log('\nQueue files under each project\'s .claude/claudeque/ were left alone.');
  } else {
    console.log('ClaudeQue installed.');
    console.log(`  hooks       -> ${SETTINGS}`);
    console.log(`  status line -> ${statusLine}`);
    console.log(`  busy rule   -> ${mdPath}`);
    console.log(`  engine      -> ${HOOK}`);
    if (statusLine.startsWith('skipped')) {
      console.log('\nTo show queue progress in your existing status line, call:');
      console.log(`  node "${HOOK}" statusline`);
    }
    console.log('\nRestart Claude Code, then type "que: something" in any project.');
    console.log('CLAUDE.md is only read at session start, so existing chats will');
    console.log('not pick up the rule until reopened.');
  }
} catch (err) {
  console.error(`\nInstall failed: ${err.message}`);
  process.exitCode = 1;
}
