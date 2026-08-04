/*
 * Queue state on disk.
 *
 * Writes are atomic because the hook fires as a short-lived process on every
 * turn end, and the CLI can be run at the same moment from a terminal.
 *
 * A queue is keyed by project directory, stored at
 *   <project>/.claude/claudeque/queue.json
 * so parallel Claude Code sessions in different projects never interfere.
 */

const fs = require('fs');
const path = require('path');

/*
 * A factory, never a shared constant. A `{ ...EMPTY }` spread copies the
 * `items` array by reference, so the first push on a missing-file load mutates
 * the shared default and every later clear() writes that stale array back out.
 * A short-lived hook process hides this; anything long-lived would not.
 */
function emptyState() {
  return {
    items: [],
    consecutiveBlocks: 0,
    paused: false,
    lastTurnKey: null,
    lastPopAt: 0,
    // Text of the item currently being worked on. Needed because a popped item
    // has left the queue, so it cannot otherwise be named — and the last item
    // of a run has nothing after it to report instead.
    lastItem: null,
  };
}

function stateDir(cwd) {
  return path.join(cwd, '.claude', 'claudeque');
}

function queuePath(cwd) {
  return path.join(stateDir(cwd), 'queue.json');
}

function logPath(cwd) {
  return path.join(stateDir(cwd), 'debug.log');
}

function parkedPath(cwd) {
  return path.join(stateDir(cwd), 'parked.json');
}

/*
 * Tasks set aside because they genuinely could not proceed without an answer.
 * Parking keeps the rest of the queue moving instead of one blocked item
 * stalling everything behind it; the user reviews these at the end.
 */
function loadParked(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(parkedPath(cwd), 'utf8'));
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

function park(cwd, text, reason) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const items = loadParked(cwd);
  const item = {
    id: newId(),
    text: trimmed,
    reason: String(reason || '').trim() || 'No reason given.',
    parkedAt: new Date().toISOString(),
  };
  items.push(item);

  const dir = stateDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.parked.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2), 'utf8');
  fs.renameSync(tmp, parkedPath(cwd));
  return item;
}

function clearParked(cwd) {
  try {
    fs.unlinkSync(parkedPath(cwd));
  } catch {
    /* nothing parked */
  }
}

function load(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(queuePath(cwd), 'utf8'));
    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      consecutiveBlocks: parsed.consecutiveBlocks || 0,
      paused: !!parsed.paused,
      lastTurnKey: parsed.lastTurnKey || null,
      lastPopAt: parsed.lastPopAt || 0,
      lastItem: parsed.lastItem || null,
    };
  } catch {
    return emptyState();
  }
}

/*
 * Write via a temp file + rename. Without this the hook can read a partially
 * written file mid-save and silently treat the queue as empty, letting Claude
 * stop with items still pending.
 */
function save(cwd, state) {
  const dir = stateDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.queue.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, queuePath(cwd));
}

function log(cwd, entry) {
  try {
    fs.mkdirSync(stateDir(cwd), { recursive: true });
    fs.appendFileSync(
      logPath(cwd),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
      'utf8'
    );
  } catch {
    /* logging must never break the hook */
  }
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function add(cwd, text, { front = false } = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const state = load(cwd);
  const item = { id: newId(), text: trimmed, addedAt: new Date().toISOString() };
  if (front) state.items.unshift(item);
  else state.items.push(item);
  save(cwd, state);
  return item;
}

function remove(cwd, id) {
  const state = load(cwd);
  const i = state.items.findIndex((it) => it.id === id);
  if (i === -1) return false;
  state.items.splice(i, 1);
  save(cwd, state);
  return true;
}

function update(cwd, id, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  const state = load(cwd);
  const item = state.items.find((it) => it.id === id);
  if (!item) return false;
  item.text = trimmed;
  save(cwd, state);
  return true;
}

/* delta of -1 moves an item earlier, +1 later. */
function move(cwd, id, delta) {
  const state = load(cwd);
  const i = state.items.findIndex((it) => it.id === id);
  const j = i + delta;
  if (i === -1 || j < 0 || j >= state.items.length) return false;
  const [item] = state.items.splice(i, 1);
  state.items.splice(j, 0, item);
  save(cwd, state);
  return true;
}

function setPaused(cwd, paused) {
  const state = load(cwd);
  state.paused = !!paused;
  save(cwd, state);
  return state.paused;
}

function clear(cwd) {
  save(cwd, emptyState());
}

module.exports = {
  emptyState,
  stateDir,
  queuePath,
  logPath,
  parkedPath,
  loadParked,
  park,
  clearParked,
  load,
  save,
  log,
  add,
  remove,
  update,
  move,
  setPaused,
  clear,
};
