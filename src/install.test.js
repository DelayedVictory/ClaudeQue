/* Installer tests — run against a throwaway HOME, never the real one. */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const HOME = path.join(REPO, '.installhome');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const CLAUDE_MD = path.join(HOME, '.claude', 'CLAUDE.md');

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

function run(...args) {
  return spawnSync(process.execPath, [path.join(REPO, 'install.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: HOME, HOME },
  });
}

const settings = () => JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
const ourHooks = (event) =>
  (settings().hooks[event] || []).filter((e) => /claudeque/i.test(JSON.stringify(e)));

fs.rmSync(HOME, { recursive: true, force: true });

// --- install into an empty home
run();
check('creates all three hook events', Object.keys(settings().hooks).sort(),
  ['PreToolUse', 'Stop', 'UserPromptSubmit']);
check('  one Stop hook', ourHooks('Stop').length, 1);
check('  one PreToolUse hook', ourHooks('PreToolUse').length, 1);
check('  path is absolute and forward-slashed',
  /^node "[A-Za-z]:\/.*\/src\/hook\.js" stop$/.test(settings().hooks.Stop[0].hooks[0].command), true);
check('writes the busy rule', fs.readFileSync(CLAUDE_MD, 'utf8').includes('que:'), true);
check('installs the status line', /claudeque/i.test(JSON.stringify(settings().statusLine)), true);

// --- re-running must not duplicate
run();
run();
check('re-install does not duplicate hooks', ourHooks('Stop').length, 1);
check('re-install does not duplicate the rule',
  fs.readFileSync(CLAUDE_MD, 'utf8').split('BEGIN ClaudeQue').length - 1, 1);

// --- foreign config must survive
const s = settings();
s.hooks.Stop.unshift({ hooks: [{ type: 'command', command: 'echo somebody-elses-hook' }] });
// A foreign hook that merely mentions ClaudeQue must NOT be treated as ours.
s.hooks.Stop.unshift({
  hooks: [{ type: 'command', command: 'echo "backing up ClaudeQue queue"' }],
});
s.hooks.PreToolUse = [{ hooks: [{ type: 'command', command: 'echo foreign' }] }];
s.permissions = { allow: ['Bash(ls:*)'] };
fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
fs.writeFileSync(CLAUDE_MD, '# My own notes\n\nKeep me.\n\n' + fs.readFileSync(CLAUDE_MD, 'utf8'));

run();
check('foreign Stop hook survives',
  settings().hooks.Stop.some((e) => JSON.stringify(e).includes('somebody-elses-hook')), true);
check('foreign event survives', !!settings().hooks.PreToolUse, true);
check('unrelated settings survive', settings().permissions.allow, ['Bash(ls:*)']);

// statusLine is a single field, not a list — overwriting someone's existing
// status line would silently destroy their config.
const mine = { type: 'command', command: 'my-own-statusline.sh' };
const s2 = settings();
s2.statusLine = mine;
fs.writeFileSync(SETTINGS, JSON.stringify(s2, null, 2));
run();
check('an existing status line is never overwritten', settings().statusLine, mine);
check('  and the installer says it skipped', run().stdout.includes('skipped'), true);
run('--uninstall');
check('  uninstall leaves it alone too', settings().statusLine, mine);
delete s2.statusLine;
fs.writeFileSync(SETTINGS, JSON.stringify(s2, null, 2));
run();
check('user CLAUDE.md content survives',
  fs.readFileSync(CLAUDE_MD, 'utf8').includes('Keep me.'), true);
check('  and ours is still there once',
  fs.readFileSync(CLAUDE_MD, 'utf8').split('BEGIN ClaudeQue').length - 1, 1);

// --- uninstall removes only ours
run('--uninstall');
check('our hooks are gone',
  settings().hooks.Stop.filter((e) => /hook\.js/i.test(JSON.stringify(e))).length, 0);
// The foreign PreToolUse hook planted above must survive, but ours must not:
// leaving auto-approval installed after an uninstall would be a security bug.
check('  our PreToolUse auto-approval is gone', ourHooks('PreToolUse').length, 0);
check('  foreign PreToolUse hook survives',
  settings().hooks.PreToolUse.some((e) => JSON.stringify(e).includes('foreign')), true);
check('foreign Stop hook still there',
  settings().hooks.Stop.some((e) => JSON.stringify(e).includes('somebody-elses-hook')), true);
check('foreign hook merely naming ClaudeQue survives',
  settings().hooks.Stop.some((e) => JSON.stringify(e).includes('backing up ClaudeQue')), true);
check('foreign event still there', !!settings().hooks.PreToolUse, true);
check('user CLAUDE.md content still there',
  fs.readFileSync(CLAUDE_MD, 'utf8').includes('Keep me.'), true);
check('our rule is gone',
  fs.readFileSync(CLAUDE_MD, 'utf8').includes('BEGIN ClaudeQue'), false);
check('our status line is gone', settings().statusLine, undefined);

// --- a corrupt settings file must never be overwritten
const corrupt = '{ this is not json';
fs.writeFileSync(SETTINGS, corrupt);
const bad = run();
check('refuses to run on unparseable settings', bad.status, 1);
check('  and leaves the file untouched', fs.readFileSync(SETTINGS, 'utf8'), corrupt);
check('  and says why', bad.stderr.includes('not valid JSON'), true);

console.log(`\n${failures === 0 ? 'All installer tests passed.' : failures + ' FAILURE(S).'}`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
