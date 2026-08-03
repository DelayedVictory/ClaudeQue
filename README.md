# ClaudeQue

A small always-on-top window holding a prompt queue for Claude Code. Prompts are
delivered **one at a time**, each only after the previous one has genuinely
finished.

Claude Code's built-in queue flushes everything at the next *LLM pause* — between
tool calls, after a subagent returns — so a batch of prompts lands mid-task and
derails whatever Claude was doing. ClaudeQue uses the `Stop` hook, which fires
only at true end-of-turn, to release exactly one prompt per completed turn.

---

## Install

Requires Node 18+ and the Claude Code desktop app. Clone or copy the folder
anywhere, then:

```bash
npm install
node install.js
```

That registers two hooks in `~/.claude/settings.json` and adds a rule to
`~/.claude/CLAUDE.md`, both pointing at wherever you put the repo. It merges
in place — existing hooks, permissions and CLAUDE.md content are preserved —
and is safe to re-run.

**Restart Claude Code afterwards.** Hooks reload live, but `CLAUDE.md` is only
read at session start, so chats already open won't pick up the rule.

Then type `que: something` in any project.

To remove it:

```bash
node install.js --uninstall
```

Queue files under each project's `.claude/claudeque/` are left alone.

The GUI is optional — `npm start`, or double-click `ClaudeQue.bat` on Windows.

Queues live per-project at `<project>/.claude/claudeque/queue.json`, so parallel
sessions never interfere.

**The queue drains whether or not the app is open.** The hook reads the queue
file directly; the GUI is just an editor for it. Close the window and a queued
run keeps going.

---

## Using it

1. Pick a project from the dropdown. Live Claude Code sessions are detected
   automatically and marked `•`; use **+** to add any other folder.
2. Type a prompt and press **Ctrl+Enter** (or click *Add to queue*).
3. Give Claude a starting task. When that turn ends, the queue takes over.

Per item: **▲▼** to reorder, **✕** to remove, double-click the text to edit.
**Pause** stops delivery after the current item without discarding anything.

### From the terminal

The CLI acts on the queue for the current directory:

```bash
node src/hook.js add "write tests for the parser"
node src/hook.js list
node src/hook.js remove 2
node src/hook.js pause
node src/hook.js resume
node src/hook.js clear
```

---

## Behaviour

- **Nothing is lost.** Items leave `queue.json` only when popped, and the pop is
  written to disk before the response is emitted. Closing the app, an error, or
  a stalled run all leave the remainder intact.
- **Focus is irrelevant.** The hook runs in the Claude Code process, not the UI.
  Minimize the window or switch apps — the queue keeps draining.
- **Your messages win.** Send something mid-run and it takes that turn; the queue
  resumes on the next one.

### What stops a run

| Cause | Behaviour |
| --- | --- |
| Queue empties | Hook returns `{}`, Claude stops normally |
| Pause | Stops after the current item; items are held |
| Claude needs input (e.g. a permission prompt) | The turn never ends, so no `Stop` fires — it waits for you |
| **You interrupt the turn** (Esc) | `Stop` does not fire on interrupt, so the queue freezes. Send any message to resume. |
| App or session closed | Items persist and resume next session |

The interrupt case is the one that looks broken but isn't: the queue sits at its
current count indefinitely with nothing in the log. If a queue seems stuck,
check whether that turn was interrupted or is waiting on a permission prompt
before suspecting the hook.

### Sessions started before setup have no `que:` support

**Hooks reload live; `~/.claude/CLAUDE.md` does not.** It is read once at session
start, so a chat opened before that file existed has no busy-path rule — typing
`que:` there reaches Claude as an ordinary message, and it may *reply* as though
it queued something while writing nothing to disk.

There is no way to inject the rule into a running session. If `que:` seems to be
accepted but the queue stays empty, close and reopen that chat.

## Unattended runs

Queued tasks run with nobody watching, so two things that normally pause Claude
would otherwise stall a whole queue.

**Clarifying questions.** Every injected task carries an instruction not to ask
— choose the most reasonable interpretation, proceed, and state the assumption.
If a task genuinely cannot proceed (missing credentials, a destructive choice
with no safe default) Claude *parks* it and moves on:

```bash
node src/hook.js parked    # what was set aside, and why
node src/hook.js unpark    # clear the list
```

Parked tasks live in `parked.json`, separate from the queue, so the rest keeps
draining.

**The `AskUserQuestion` tool.** This is the one that really bites, and
`bypassPermissions` does *not* save you: bypass approves the tool *running*, and
running it means rendering a dialog and waiting for a human. The turn stays open,
no `Stop` fires, and every task behind it freezes.

So while a queue is draining, a `PreToolUse` hook **denies** that one tool, with
a reason telling Claude to decide and proceed, or park. Denials are recorded in
`.claude/claudeque/debug.log` as `deny-question` entries, along with what it
wanted to ask — worth reading afterwards to see what it guessed.

The hook touches **nothing else**. Every other tool defers to the normal
permission flow, so whatever gate a session already has is unchanged, and outside
a queued run `AskUserQuestion` works as usual.

### Known limits

- Prompts arrive as **hook feedback inside one long turn**, not as fresh user
  turns. Context never resets between items, and long runs will hit
  auto-compaction mid-queue. Untested with substantial real-world prompts.
- If Claude produces a byte-identical reply for two consecutive items within 2s,
  the duplicate-invocation guard suppresses the second pop and the queue waits a
  turn. Tune with `CLAUDEQUE_DEDUPE_MS`.

### Why there is no `next:` chat command

An earlier version let you type `next: <prompt>` in the chat, intercepted via a
`UserPromptSubmit` hook. It was removed: that hook only fires when Claude is
**idle**. Anything typed while Claude is working is a steering message that
bypasses hooks entirely — which is exactly when you want to queue. The chat box
is unavailable at the only moment it would matter, so the queue needs its own
window.

---

## Verified on Claude Code desktop v2.1.219

- 10 queued prompts delivered one at a time, in order, then a clean stop.
- **No block cap.** 10 consecutive `Stop` blocks with no throttling — the widely
  repeated "hard cap of 8" does not apply. `CLAUDEQUE_MODE=context` switches
  injection to `hookSpecificOutput.additionalContext` as a fallback if that ever
  changes.

---

## Layout

| Path | Purpose |
| --- | --- |
| `main.js` | Electron main — window, project discovery, IPC, polling |
| `preload.js` | `contextBridge` API for the renderer |
| `renderer/` | UI |
| `src/queue.js` | Queue state, shared by the hook and the GUI. Atomic writes. |
| `src/hook.js` | The `Stop` hook, and the CLI |
| `src/test.js` | 41 tests — `npm test` |
