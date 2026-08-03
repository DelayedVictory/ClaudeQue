const $ = (id) => document.getElementById(id);

const el = {
  project: $('project'),
  browse: $('browse'),
  forget: $('forget'),
  pin: $('pin'),
  count: $('count'),
  pause: $('pause'),
  clear: $('clear'),
  list: $('list'),
  empty: $('empty'),
  input: $('input'),
  add: $('add'),
  statusbar: $('statusbar'),
  statustext: $('statustext'),
  statusaction: $('statusaction'),
};

let state = { projects: [], queue: null, status: null, watched: null };
let editingId = null; // suppress re-render while an item is being edited

// ---------------------------------------------------------------- render

function renderProjects() {
  const sel = el.project;
  const want = state.watched || '';
  const sig = state.projects.map((p) => `${p.dir}|${p.live}|${p.count}`).join(',');
  if (sel.dataset.sig !== sig || sel.value !== want) {
    sel.dataset.sig = sig;
    sel.innerHTML = '';

    if (!state.projects.length) {
      sel.append(new Option('No projects — click + to add', ''));
    } else {
      sel.append(new Option('Select a project…', ''));
      for (const p of state.projects) {
        const bits = [p.name];
        if (p.count) bits.push(`(${p.count})`);
        if (p.live) bits.push('•');
        sel.append(new Option(bits.join(' '), p.dir));
      }
    }
    sel.value = want;
  }
}

function renderStatus() {
  const qs = state.queue;
  if (!state.watched) {
    el.count.textContent = 'no project selected';
  } else if (!qs || !qs.items.length) {
    el.count.textContent = qs && qs.paused ? 'empty · paused' : 'empty';
  } else {
    const n = qs.items.length;
    el.count.textContent = `${n} queued${qs.paused ? ' · PAUSED' : ''}`;
  }

  const paused = !!(qs && qs.paused);
  document.body.classList.toggle('paused', paused);
  el.pause.textContent = paused ? 'Resume' : 'Pause';
  el.pause.disabled = !state.watched;
  el.clear.disabled = !state.watched || !qs || !qs.items.length;
  el.forget.disabled = !state.watched;
  el.add.disabled = !state.watched;
  el.input.disabled = !state.watched;
}

function renderList() {
  if (editingId) return; // don't clobber an in-progress edit

  const items = (state.queue && state.queue.items) || [];
  el.list.innerHTML = '';
  el.empty.style.display = items.length ? 'none' : 'flex';
  el.list.style.display = items.length ? 'block' : 'none';

  items.forEach((item, i) => {
    const li = document.createElement('li');
    if (i === 0) li.className = 'next';

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = i + 1;

    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = item.text;
    text.title = 'Double-click to edit';
    text.addEventListener('dblclick', () => beginEdit(text, item));

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      button('▲', 'Move up', i === 0, () => window.cq.move(item.id, -1)),
      button('▼', 'Move down', i === items.length - 1, () =>
        window.cq.move(item.id, 1)
      ),
      button('✕', 'Remove', false, () => window.cq.remove(item.id))
    );

    li.append(num, text, actions);
    el.list.append(li);
  });
}

function button(label, title, disabled, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

function beginEdit(node, item) {
  editingId = item.id;
  node.contentEditable = 'true';
  node.focus();

  const finish = async (save) => {
    node.contentEditable = 'false';
    editingId = null;
    if (save && node.textContent.trim() !== item.text) {
      await window.cq.update(item.id, node.textContent);
    } else {
      node.textContent = item.text;
    }
    refresh();
  };

  node.addEventListener('blur', () => finish(true), { once: true });
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      node.blur();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      node.blur();
    }
  });
}

/*
 * The queue only advances when a turn ENDS, so "nothing is happening" has
 * several causes that look identical from this window. Spell out which one.
 */
function renderStatusBar() {
  const s = state.status;
  const bar = el.statusbar;

  if (!s || s.state === 'empty') {
    bar.className = 'statusbar';
    el.statusaction.className = 'tiny hidden';
    return;
  }

  el.statustext.textContent = s.label;

  const attention = s.state !== 'working';
  bar.className = `statusbar show ${attention ? 'attention' : 'working'}`;

  if (s.action === 'resume') {
    el.statusaction.textContent = 'Resume';
    el.statusaction.className = 'tiny';
  } else if (s.action === 'focus') {
    el.statusaction.textContent = 'Go to session';
    el.statusaction.className = 'tiny';
  } else {
    el.statusaction.className = 'tiny hidden';
  }
}

el.statusaction.addEventListener('click', async () => {
  const s = state.status;
  if (!s) return;
  if (s.action === 'resume') await window.cq.setPaused(false);
  else if (s.action === 'focus') await window.cq.focusSession();
  refresh();
});

function render() {
  renderProjects();
  renderStatus();
  renderStatusBar();
  renderList();
}

async function refresh() {
  state = await window.cq.getState();
  render();
}

// ---------------------------------------------------------------- actions

async function addPrompt() {
  const text = el.input.value.trim();
  if (!text || !state.watched) return;
  await window.cq.add(text);
  el.input.value = '';
  el.input.focus();
  refresh();
}

el.add.addEventListener('click', addPrompt);

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    addPrompt();
  }
});

el.project.addEventListener('change', async () => {
  await window.cq.selectProject(el.project.value || null);
  refresh();
});

el.browse.addEventListener('click', async () => {
  await window.cq.browseProject();
  refresh();
});

el.forget.addEventListener('click', async () => {
  const dir = state.watched;
  if (!dir) return;
  const n = (state.queue && state.queue.items.length) || 0;
  const warning = n
    ? `\n\n${n} queued prompt${n === 1 ? '' : 's'} will stay on disk and still run.`
    : '';
  if (!confirm(`Remove ${dir} from the list?${warning}`)) return;
  await window.cq.forgetProject(dir);
  refresh();
});

el.pause.addEventListener('click', async () => {
  const paused = !!(state.queue && state.queue.paused);
  await window.cq.setPaused(!paused);
  refresh();
});

el.clear.addEventListener('click', async () => {
  const n = (state.queue && state.queue.items.length) || 0;
  if (!n) return;
  if (!confirm(`Remove all ${n} queued prompt${n === 1 ? '' : 's'}?`)) return;
  await window.cq.clear();
  refresh();
});

el.pin.addEventListener('click', async () => {
  const on = el.pin.classList.toggle('on');
  await window.cq.pin(on);
});

// ---------------------------------------------------------------- boot

window.cq.onState((s) => {
  state = s;
  render();
});

refresh();
