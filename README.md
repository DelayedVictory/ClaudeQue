# ClaudeQue

Queue prompts for Claude Code by typing `que:` in the chat. They're delivered
**one at a time**, each only after the previous one has genuinely finished.

```
que: fix the header alignment
que: then write tests for it
que: then update the changelog
```

Claude Code's built-in queue flushes everything at the next *LLM pause* —
between tool calls, after a subagent returns — so a batch of prompts lands
mid-task and derails whatever Claude was doing. ClaudeQue uses the `Stop` hook,
which fires only at true end-of-turn, to release exactly one prompt per
completed turn.

No dependencies. Node and Claude Code, nothing else.

---

## Install

```bash
git clone https://github.com/DelayedVictory/ClaudeQue.git
cd ClaudeQue
node install.js
```

This registers three hooks in `~/.claude/settings.json` and adds a rule to
`~/.claude/CLAUDE.md`, both pointing at wherever you cloned it. It merges in
place — your existing hooks, permissions and CLAUDE.md content are preserved —
and is safe to re-run.

**Restart Claude Code afterwards.** Hooks reload live, but `CLAUDE.md` is only
read at session start, so chats already open won't pick up the rule.

To remove it:

```bash
node install.js --uninstall
```

Queue files under each project's `.claude/claudeque/` are left alone.

---

## Using it

Type `que: <task>` in any chat. Then send any message to start things off — the
queue drains at the *end of a turn*, so if Claude is idle and nothing is
running, nothing happens until a turn ends.

`que:`, `queue:` and `q:` all work.

Only a line *starting* with one of those splits off a new item, so ordinary
prose and indented continuation lines stay part of the same task.

**One item, multi-line** — a prompt keeps its shape:

```
que: fix the header
     - keep it centred
     - add a test
```

**Several items** — repeat the prefix per line:

```
que: something 1
que: something 2
```

### Watching a run

A long queue shows its progress in Claude Code's status line, so you can see
where it is without opening a terminal:

```
⏳ 4/12 · 3m · next: update the changelog
```

Delivered out of the run total, how long the current item has been going, and
what's up next. Paused queues and parked tasks show there too. It refreshes
every 10 seconds, and prints nothing at all when there's no queue.

When items are waiting but nothing has been delivered recently — you queued
them and walked away, or restarted mid-run — it says so instead, because the
queue needs a turn to end before it moves:

```
⏳ 2 waiting · send any message to start
```

If you already have a status line, the installer leaves it alone and tells you
how to call ClaudeQue's from your own script.

### From the terminal

Acts on the queue for the current directory:

```bash
node src/hook.js list
node src/hook.js add "write tests for the parser"
node src/hook.js edit 2 "revised wording"
node src/hook.js move 3 up
node src/hook.js remove 2
node src/hook.js requeue-last   # put an interrupted task back at the front
node src/hook.js pause
node src/hook.js resume
node src/hook.js clear
```

Queues live per-project at `<project>/.claude/claudeque/queue.json`, so parallel
sessions never interfere.

---

## Unattended runs

A queue is useless if item 5 stops and waits for you, so two things are handled.

**Questions.** While a queue is draining, a `PreToolUse` hook denies the
`AskUserQuestion` tool and tells Claude to choose the most reasonable option,
proceed, and state the assumption it made.

`bypassPermissions` does *not* solve this on its own: bypass approves the tool
*running*, and running it means rendering a dialog and waiting. The turn stays
open, no `Stop` fires, and every task behind it freezes.

The hook touches **nothing else** — every other tool defers to the normal
permission flow, and outside a queued run `AskUserQuestion` works as usual.

**Genuinely blocked tasks.** If a task can't proceed without an answer (missing
credentials, a destructive choice with no safe default), Claude parks it and
moves on rather than stalling the queue:

```bash
node src/hook.js parked    # what was set aside, and why
node src/hook.js unpark    # clear the list
```

The trade is real: item 5 now completes on an assumption instead of waiting.
`deny-question` entries in `.claude/claudeque/debug.log` record what it wanted
to ask, which is worth skimming after a long run.

### Images

The queue is plain text, so an attachment does not travel with a task by
itself — and the `UserPromptSubmit` payload has no attachment field at all, so
the idle path never sees one.

On the busy path Claude does see the image, and the `CLAUDE.md` rule tells it
to preserve it:

```bash
node src/hook.js attach "<path>"   # copies it beside the queue, prints the new path
```

The copy matters because a task may not run for hours, by which time the
original temp file is gone. Names are timestamped and de-duplicated, so two
screenshots called `Screenshot.png` cannot overwrite each other.

An image pasted inline has no path and cannot be saved; Claude appends a short
description instead, marked as coming from a screenshot. Either way a queued
task should never just say "the image" — by the time it runs there is nothing
to look at.

You can always do it yourself: put the file in the repo and reference the path
in the task text.

### Follow-up work

When the last task of a run completes, Claude is asked once whether anything
should follow — suggested tasks it flagged, things noticed in passing, work
left unfinished — and queues them if so.

It is explicitly allowed to answer "nothing outstanding", because a model asked
to find work will find some. Padding the queue with make-work is worse than
ending it.

It cannot chain: tasks a wrap-up produced are marked, and delivering one does
not arm another wrap-up, so a queue cannot grow indefinitely overnight. Only
ordinary work re-arms it.

Set `CLAUDEQUE_NO_WRAPUP=1` to switch it off.

> Suggested-task **chips** are not readable from disk — `~/.claude/tasks/` holds
> the todo list, not the chips — which is why this asks Claude rather than
> reading them. Claude has its own suggestions in context.

---

## Behaviour

- **Nothing is lost.** Items leave `queue.json` only when popped, and the pop is
  written to disk before the response is emitted. An error, a stalled run, or a
  closed session all leave the remainder intact.
- **Focus is irrelevant.** The hook runs inside Claude Code. Minimise the window
  or switch apps; the queue keeps draining.
- **Your messages win.** Send something mid-run and it takes that turn; the
  queue resumes on the next one.

### What stops a run

| Cause | Behaviour |
| --- | --- |
| Queue empties | Hook returns `{}`, Claude stops normally |
| `pause` | Stops after the current item; items are held |
| **You interrupt the turn** (Esc) | `Stop` does not fire on interrupt, so the queue freezes. Send any message to resume. |
| Rate limit or crash mid-task | Same as an interrupt: the turn dies abnormally, no `Stop` fires, and the queue waits. Send any message once it clears. |
| Plan mode | `ExitPlanMode` waits for approval and is not handled. Don't queue into a plan-mode session. |
| Permission prompt (if not in bypass) | Does not end the turn, so no `Stop` fires |
| Session closed or Claude restarted | Items persist on disk. The run does **not** auto-resume — send any message to start it again. |

The interrupt case is the one that looks broken but isn't: the queue sits at its
count indefinitely with nothing new in the log.

**The task that was running is not retried.** An item is popped *before* it is
handed to Claude, so a turn that dies takes its task out of the queue with it —
the run resumes at the next item and that one silently never completes. To put
it back at the front:

```bash
node src/hook.js requeue-last
```

It comes back flagged `[resumed]`, and the flag travels with it until delivery.
When it eventually runs, Claude is told the task was interrupted and to check
`git status`, `git diff` and the files involved before changing anything — so
partly-finished work is continued rather than redone.

---

## How it works

Three hooks in `~/.claude/settings.json`, all running `src/hook.js`:

| Hook | Mode | Job |
| --- | --- | --- |
| `UserPromptSubmit` | `enqueue` | Catches `que:` when Claude is **idle** and files it |
| `Stop` | `stop` | Fires at true end-of-turn; pops one item and injects it |
| `PreToolUse` | `pretool` | Denies `AskUserQuestion` while a queue is draining |

Plus a `statusLine` entry running `statusline`, which renders queue progress.

Delivery returns `{"decision":"block","reason":"<task>"}`. In the hook API
`block` means *don't stop yet* — it blocks the stop, not your prompt, and
`reason` becomes Claude's next instruction. Claude Code renders this in error
styling; that red line is the queue working.

Plus a rule in `~/.claude/CLAUDE.md`, which covers the case hooks can't:

> **`UserPromptSubmit` only fires when Claude is idle.** Anything typed while
> Claude is *working* is a steering message that bypasses hooks entirely and
> lands mid-turn — verified by experiment. Since that's exactly when you want to
> queue, the rule tells Claude to file `que:` messages itself and carry on.

That half is an instruction rather than a hook, so it's reliable but not
guaranteed. If a session ever answers a `que:` message instead of queueing it,
that's why — and a session started before the rule existed won't have it at all.

---

## Verified on Claude Code desktop v2.1.219

Tested, not assumed:

- 10 queued prompts delivered one at a time, in order, then a clean stop.
- **No `Stop`-hook block cap.** 10 consecutive blocks, no throttling. The widely
  repeated "hard cap of 8" is folklore; the docs correctly document no limit.
- **`UserPromptSubmit` fires only when idle.** `que: idle test` logged
  `matched:true`; `que: busy test` typed during a 90-second task never reached
  the hook at all.
- **`Stop` does not fire on user interrupt.**

### Known limits

- Prompts arrive as **hook feedback inside one long turn**, not as fresh user
  turns. Context never resets between items, and long runs will hit
  auto-compaction mid-queue. Untested with substantial real-world prompts.
- If Claude produces a byte-identical reply for two consecutive items within 2s,
  the duplicate-invocation guard suppresses the second pop and the queue waits a
  turn. Tune with `CLAUDEQUE_DEDUPE_MS`.
- Windows-tested only. The code is plain Node with no platform-specific paths,
  so it should work elsewhere, but nobody has checked.

---

## Layout

| Path | Purpose |
| --- | --- |
| `install.js` | Merges hooks and the rule into `~/.claude/`; `--uninstall` reverses it |
| `src/hook.js` | All three hook modes, and the CLI |
| `src/queue.js` | Queue state. Atomic writes. |
| `src/test.js` | Engine tests |
| `src/install.test.js` | Installer tests — that it never clobbers foreign config |

```bash
npm test
```
