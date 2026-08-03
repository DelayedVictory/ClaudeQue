const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const q = require('./src/queue');

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const POLL_MS = 800;

let win = null;
let watched = null; // project dir currently shown
let lastSent = ''; // serialised snapshot, to avoid redundant renders

// ---------------------------------------------------------------- config

function configPath() {
  return path.join(app.getPath('userData'), 'projects.json');
}

/*
 * configReadable is false only when the file exists but could not be parsed.
 * In that case we must never write over it — an unreadable config is a bug to
 * investigate, and silently replacing it with a fresh list destroys the user's
 * projects. A missing file is fine and stays writable.
 */
let configReadable = true;

function loadProjects() {
  let raw;
  try {
    raw = fs.readFileSync(configPath(), 'utf8');
  } catch {
    configReadable = true; // no file yet — safe to create one
    return [];
  }

  try {
    // Strip a UTF-8 BOM: PowerShell and several Windows editors add one.
    const list = JSON.parse(raw.replace(/^﻿/, '').trim());
    configReadable = true;
    return Array.isArray(list) ? list : [];
  } catch (err) {
    configReadable = false;
    console.error(`ClaudeQue: cannot parse ${configPath()} — ${err.message}`);
    return [];
  }
}

function saveProjects(list) {
  if (!configReadable) return; // refuse to clobber a config we failed to read
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(list, null, 2), 'utf8');
  } catch {
    /* non-fatal */
  }
}

/*
 * Claude Code writes one file per live session naming its cwd, so running
 * sessions can be discovered without the user pointing at anything.
 */
function liveSessions() {
  try {
    return fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter((s) => s && s.cwd);
  } catch {
    return [];
  }
}

/*
 * Claude Code stores a session transcript at
 *   ~/.claude/projects/<cwd with : \ / replaced by ->/<sessionId>.jsonl
 * and appends to it as the turn progresses, so its mtime is a good proxy for
 * "is this session actually doing anything right now".
 */
function lastActivity(cwd) {
  const dir = path.join(
    os.homedir(),
    '.claude',
    'projects',
    cwd.replace(/[:\\/]/g, '-')
  );
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .reduce((newest, f) => {
        const t = fs.statSync(path.join(dir, f)).mtimeMs;
        return t > newest ? t : newest;
      }, 0);
  } catch {
    return 0;
  }
}

/* Timestamp and action of the most recent hook fire for a project. */
function lastHookEvent(cwd) {
  try {
    const lines = fs.readFileSync(q.logPath(cwd), 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (e.event === 'stop') return e;
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* no log yet */
  }
  return null;
}

/*
 * Transcript mtime is only a proxy for activity: it updates per message and
 * tool result, so a single long-running command (a build, a test suite) writes
 * nothing for minutes while Claude is very much working. Keep this generous —
 * a false "stalled" is worse than noticing a real one late.
 */
const IDLE_AFTER_MS = 150_000;

/*
 * Derive a human-readable state. The queue only advances when a turn ENDS, so
 * "nothing happening" has several distinct causes that look identical from
 * here — the whole point of this is to tell them apart.
 */
function projectStatus(dir, live) {
  const state = q.load(dir);
  const n = state.items.length;
  const session = live.find((s) => s.cwd === dir);
  const last = lastHookEvent(dir);
  const idleFor = Date.now() - lastActivity(dir);

  const base = { count: n, paused: state.paused, pid: session ? session.pid : null };

  if (!n) return { ...base, state: 'empty', label: 'Queue is empty.' };

  if (state.paused)
    return {
      ...base,
      state: 'paused',
      label: `Paused — ${n} held. Nothing will be delivered.`,
      action: 'resume',
    };

  if (!session)
    return {
      ...base,
      state: 'no-session',
      label: `${n} queued, but no Claude Code session is open in this folder.`,
    };

  if (idleFor < IDLE_AFTER_MS)
    return {
      ...base,
      state: 'working',
      label: `${n} queued — Claude is working. Next goes in when this turn ends.`,
    };

  const mins = Math.round(idleFor / 60000);
  const delivered = last && last.action === undefined;
  return {
    ...base,
    state: 'stalled',
    label:
      `${n} queued — no activity for ${mins} min. ` +
      (delivered
        ? 'The turn may have been interrupted, or be awaiting approval.'
        : 'Waiting for a turn to end.') +
      ' If it is genuinely stuck, send any message there to resume.',
    action: 'focus',
  };
}

function projectList() {
  const live = liveSessions();
  const liveCwds = new Set(live.map((s) => s.cwd));

  /*
   * Remember every session directory as it is seen. Claude Code deletes a
   * session's file when it closes, so discovery alone only ever shows what is
   * running right now — a project worked on an hour ago would silently vanish
   * from the list.
   */
  const remembered = loadProjects();
  const unseen = [...liveCwds].filter((d) => !remembered.includes(d));
  if (unseen.length) {
    remembered.push(...unseen);
    saveProjects(remembered);
  }

  const all = [...new Set([...liveCwds, ...remembered])];
  return all
    .map((dir) => ({
      dir,
      name: path.basename(dir),
      live: liveCwds.has(dir),
      count: q.load(dir).items.length,
      paused: q.load(dir).paused,
    }))
    .sort((a, b) => Number(b.live) - Number(a.live) || a.name.localeCompare(b.name));
}

function remember(dir) {
  const list = loadProjects();
  if (!list.includes(dir)) saveProjects([...list, dir]);
}

// ---------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 680,
    minWidth: 360,
    minHeight: 420,
    title: 'ClaudeQue',
    alwaysOnTop: true,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => (win = null));
}

/*
 * Poll rather than fs.watch: queue writes land via temp-file + rename, which
 * fs.watch reports inconsistently on Windows. Polling a small JSON file is
 * cheap and never misses an edit made by the hook.
 */
function startPolling() {
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const snapshot = JSON.stringify({
      projects: projectList(),
      queue: watched ? q.load(watched) : null,
      status: watched ? projectStatus(watched, liveSessions()) : null,
      watched,
    });
    if (snapshot !== lastSent) {
      lastSent = snapshot;
      win.webContents.send('state', JSON.parse(snapshot));
    }
  }, POLL_MS);
}

// ---------------------------------------------------------------- ipc

function push() {
  lastSent = ''; // force the next poll to emit
}

ipcMain.handle('state:get', () => ({
  projects: projectList(),
  queue: watched ? q.load(watched) : null,
  status: watched ? projectStatus(watched, liveSessions()) : null,
  watched,
}));

/*
 * Bring the stalled Claude Code window forward so the user can type. This is
 * the most an external app can do — there is no supported way to push a message
 * into a running interactive session.
 */
ipcMain.handle('session:focus', (_e) => {
  if (!watched) return false;
  const session = liveSessions().find((s) => s.cwd === watched);
  if (!session || !session.pid) return false;

  const { spawn } = require('child_process');
  const byPlatform = {
    win32: ['powershell', ['-NoProfile', '-Command',
      `(New-Object -ComObject WScript.Shell).AppActivate(${session.pid})`]],
    darwin: ['osascript', ['-e',
      `tell application "System Events" to set frontmost of (first process whose unix id is ${session.pid}) to true`]],
    // No portable way to raise a window by pid on Linux; wmctrl is not assumed.
  };

  const cmd = byPlatform[process.platform];
  if (!cmd) return false;

  spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return true;
});

ipcMain.handle('project:select', (_e, dir) => {
  watched = dir;
  if (dir) remember(dir);
  push();
  return true;
});

ipcMain.handle('project:browse', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Pick a project folder',
  });
  if (r.canceled || !r.filePaths.length) return null;
  const dir = r.filePaths[0];
  remember(dir);
  watched = dir;
  push();
  return dir;
});

ipcMain.handle('project:forget', (_e, dir) => {
  saveProjects(loadProjects().filter((d) => d !== dir));
  if (watched === dir) watched = null;
  push();
  return true;
});

ipcMain.handle('queue:add', (_e, text) => {
  if (!watched) return false;
  const ok = !!q.add(watched, text);
  push();
  return ok;
});

ipcMain.handle('queue:remove', (_e, id) => {
  if (!watched) return false;
  const ok = q.remove(watched, id);
  push();
  return ok;
});

ipcMain.handle('queue:update', (_e, id, text) => {
  if (!watched) return false;
  const ok = q.update(watched, id, text);
  push();
  return ok;
});

ipcMain.handle('queue:move', (_e, id, delta) => {
  if (!watched) return false;
  const ok = q.move(watched, id, delta);
  push();
  return ok;
});

ipcMain.handle('queue:pause', (_e, paused) => {
  if (!watched) return false;
  q.setPaused(watched, paused);
  push();
  return true;
});

ipcMain.handle('queue:clear', () => {
  if (!watched) return false;
  q.clear(watched);
  push();
  return true;
});

ipcMain.handle('window:pin', (_e, pinned) => {
  if (win) win.setAlwaysOnTop(!!pinned);
  return !!pinned;
});

ipcMain.handle('app:openFolder', () => {
  if (watched) shell.openPath(q.stateDir(watched));
  return true;
});

// ---------------------------------------------------------------- lifecycle

app.whenReady().then(() => {
  createWindow();
  startPolling();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
