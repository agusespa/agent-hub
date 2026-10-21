const $ = (selector) => document.querySelector(selector);

const SETTINGS_KEY = 'agent-hub:view';
const STATUS_LABELS = { working: 'Working', waiting: 'Waiting on me', idle: 'Idle' };
const SOURCE_LABELS = { claude: 'Claude', codex: 'Codex' };

let board = null;
let dragging = false;
/** Where the dragged card sat before the drag, so hovering a sorted column puts it back. */
let dragOrigin = null;
/** The card whose ticket is being typed: `{ id, value }`. */
let editing = null;
let pollTimer;
/** The last save or open that failed: it stays on the banner until closed, since polls only redraw the board's errors. */
let actionError = null;
/** Each repo's hue, from its place in the sorted repo list: far apart, and steady until a repo is added. */
let repoHues = new Map();

/** The ticket filter's value for cards without one; ticket IDs are upper case, so it never clashes. */
const NO_TICKET = 'none';

/**
 * The repos, sources and tickets unticked in the filters, so new ones show, and the
 * last-active columns flipped to oldest first.
 */
const view = { hiddenRepos: [], hiddenSources: [], hiddenTickets: [], oldestFirst: [] };
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
  const strings = (values) => (Array.isArray(values) ? values.filter((v) => typeof v === 'string') : []);
  for (const key of Object.keys(view)) view[key] = strings(saved[key]);
} catch {}
const saveView = () => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(view));
  } catch {}
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const timeAgo = (ms) => {
  if (!ms) return 'unknown';
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

// Today's resets show the time only; later ones add the weekday.
const resetTime = (ms) =>
  new Date(ms).toDateString() === new Date().toDateString()
    ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

// A key typed in any case, or the last one in a pasted link (`…/browse/PROJ-12`, `?selectedIssue=PROJ-12`).
const KEY_IN_TEXT = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9}-\d{1,7})(?![A-Za-z0-9])/g;
const parseTicketId = (text) => [...text.matchAll(KEY_IN_TEXT)].at(-1)?.[1].toUpperCase() ?? null;

const matchesFilters = (card) =>
  !view.hiddenRepos.includes(card.repo) &&
  !view.hiddenSources.includes(card.source) &&
  !view.hiddenTickets.includes(card.ticket ?? NO_TICKET);

/**
 * Fills a checkbox filter with `[value, label]` options, ticked unless hidden; `plural` names several.
 * With `hueOf`, each option gets a color dot in that value's hue.
 */
const fillMultiSelect = (picker, options, hidden, plural, hueOf) => {
  // Rebuilt only when the options change, so a poll does not take focus from an open list.
  const listed = JSON.stringify(options);
  if (picker.dataset.options !== listed) {
    picker.dataset.options = listed;
    picker.querySelector('.multi-select-options').replaceChildren(
      ...options.map(([value, label]) => {
        const row = el('div', 'multi-select-option');
        const option = el('label');
        const box = el('input');
        box.type = 'checkbox';
        box.value = value;
        option.append(box);
        if (hueOf) {
          const dot = el('span', 'swatch');
          dot.style.setProperty('--repo-hue', hueOf(value));
          option.append(dot);
        }
        option.append(label);
        const only = el('button', 'link-button multi-select-only', 'Only');
        only.type = 'button';
        only.dataset.value = value;
        row.append(option, only);
        return row;
      }),
    );
  }
  for (const box of picker.querySelectorAll('input')) box.checked = !hidden.includes(box.value);
  picker.querySelector('.multi-select-clear').hidden = hidden.length === 0;
  const shown = options.filter(([value]) => !hidden.includes(value));
  picker.querySelector('.multi-select-value').textContent =
    shown.length === options.length ? 'All' : shown.length === 0 ? 'None' : shown.length === 1 ? shown[0][1] : `${shown.length} ${plural}`;
};

const renderFilters = () => {
  const unique = (values) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  // Hidden repos stay listed after their sessions drop off, so they can be ticked again.
  const repos = unique([...board.cards.map((card) => card.repo), ...view.hiddenRepos]);
  repoHues = new Map(repos.map((repo, index) => [repo, String(Math.round((150 + index * 137.5) % 360))]));
  // Repo hues follow the options, so the list is rebuilt whenever they change.
  fillMultiSelect($('#filter-repo'), repos.map((repo) => [repo, repo]), view.hiddenRepos, 'repos', (repo) => repoHues.get(repo));
  // A source that is not installed has no cards, so it says why instead of showing an error.
  const sources = Object.entries(SOURCE_LABELS).map(([source, label]) => [
    source,
    board.missingSources?.includes(source) ? `${label} (not installed)` : label,
  ]);
  fillMultiSelect($('#filter-source'), sources, view.hiddenSources, 'sources');
  // Like repos, hidden tickets stay listed; cards without one share the last option.
  const tickets = unique([...board.cards.map((card) => card.ticket), ...view.hiddenTickets.filter((ticket) => ticket !== NO_TICKET)]);
  fillMultiSelect($('#filter-ticket'), [...tickets.map((ticket) => [ticket, ticket]), [NO_TICKET, 'No ticket']], view.hiddenTickets, 'tickets');
};

const startEditing = (card) => {
  editing = { id: card.id, value: card.ticket ?? '' };
  render({ force: true });
  document.querySelector('.ticket-input')?.select();
};

const stopEditing = () => {
  editing = null;
  render();
};

/** Enter saves, an empty key removes it; Escape or clicking away cancels. */
const renderTicketEditor = (card) => {
  const form = el('form', 'ticket-editor');
  const input = el('input', 'ticket-input');
  Object.assign(input, { value: editing.value, placeholder: 'PROJ-1234 or ticket link', maxLength: 500, spellcheck: false, autocomplete: 'off' });
  input.setAttribute('aria-label', 'Ticket ID or link');
  input.addEventListener('input', () => {
    editing.value = input.value;
    input.setCustomValidity('');
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') stopEditing();
  });
  // Also fires when a save or cancel redraws the card, after `editing` is cleared.
  input.addEventListener('blur', () => {
    if (editing?.id === card.id) stopEditing();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    const key = text ? parseTicketId(text) : null;
    if (text && !key) {
      input.setCustomValidity('Enter an ID like PROJ-1234, or a ticket link.');
      input.reportValidity();
      return;
    }
    saveTicket(card, key);
  });
  form.append(input);
  return form;
};

/** The ticket and its change button, the editor, or an add button when there is none. */
const renderTicket = (card) => {
  if (editing?.id === card.id) return [renderTicketEditor(card)];
  const button = (className, text, title) => {
    const node = el('button', className, text);
    Object.assign(node, { type: 'button', title });
    node.addEventListener('click', () => startEditing(card));
    return node;
  };
  if (!card.ticket) return [button('tag ticket-add', '+ Ticket', 'Add a ticket')];
  return [el('span', 'tag ticket', card.ticket), button('icon-button ticket-change', '✎', 'Change or remove the ticket')];
};

const renderCard = (card) => {
  const isEditing = editing?.id === card.id;
  const node = el('article', `card source-${card.source}${isEditing ? ' editing' : ''}`);
  node.draggable = !isEditing;
  node.dataset.id = card.id;
  node.addEventListener('dragstart', (event) => {
    dragging = true;
    dragOrigin = { list: node.parentNode, next: node.nextElementSibling };
    event.dataTransfer.setData('text/plain', card.id);
    event.dataTransfer.effectAllowed = 'move';
    node.classList.add('dragging');
  });
  node.addEventListener('dragend', () => {
    dragging = false;
    dragOrigin = null;
    showDropTarget(null);
    render();
  });

  // Where first, so cards from the same repo match at a glance; then what, then its state.
  const top = el('div', 'card-top');
  const repo = el('span', 'repo', card.repo);
  repo.style.setProperty('--repo-hue', repoHues.get(card.repo) ?? '0');
  repo.title = card.repo;
  top.append(repo);
  if (card.branch) {
    const branch = el('span', 'branch', card.branch);
    branch.title = card.branch;
    top.append(branch);
  }
  if (card.openId) {
    const open = el('button', 'icon-button open-session', '↗');
    Object.assign(open, { type: 'button', title: `Open in ${SOURCE_LABELS[card.source]}` });
    open.addEventListener('click', () => openSession(card.id));
    top.append(open);
  }
  const ticket = el('div', 'card-ticket');
  ticket.append(...renderTicket(card));
  node.append(top, el('h3', 'title', card.title), ticket);

  const tags = el('div', 'tags');
  tags.append(el('span', `badge badge-${card.source}`, SOURCE_LABELS[card.source]));
  if (card.liveStatus) {
    const status = el('span', `status status-${card.liveStatus}`, STATUS_LABELS[card.liveStatus]);
    if (card.waitingFor) status.title = card.waitingFor;
    tags.append(status);
  }
  if (card.waitingFor) tags.append(el('span', 'tag waiting-for', card.waitingFor));
  const time = el('span', 'time', timeAgo(card.lastActiveAt));
  if (card.lastActiveAt) time.title = `Last active ${new Date(card.lastActiveAt).toLocaleString()}`;
  tags.append(time);
  node.append(tags);
  return node;
};

/** How many of the shown sessions are working or waiting on the user, or else what is in Doing. */
const renderSummary = (cards) => {
  const counts = ['working', 'waiting'].map((status) => [status, cards.filter((card) => card.liveStatus === status).length]);
  const parts = counts
    .filter(([, count]) => count > 0)
    .map(([status, count]) => {
      const part = el('span', `summary-part summary-${status}`);
      part.append(el('strong', '', String(count)), ` ${STATUS_LABELS[status].toLowerCase()}`);
      return part;
    });
  if (!parts.length) {
    const doing = cards.filter((card) => card.column === 'doing');
    const part = el('span', 'summary-part');
    if (doing.length) {
      part.append(el('strong', '', String(doing.length)), ' in Doing');
      part.title = doing.map((card) => card.title).join('\n');
    } else part.textContent = 'Nothing in Doing';
    parts.push(part);
  }
  $('#summary').replaceChildren(...parts);
};

const usageLevel = (used) => (used >= 90 ? 'high' : used >= 70 ? 'mid' : 'low');

const renderUsageWindow = (window, fetchedAt) => {
  const used = Math.min(100, Math.max(0, window.usedPercent));
  const node = el('div', `usage-window level-${usageLevel(used)}`);
  node.title = `${Math.round(used)}% used${window.resetsAt ? `, resets ${new Date(window.resetsAt).toLocaleString()}` : ''}. Checked ${new Date(fetchedAt).toLocaleTimeString()}.`;
  const meter = el('span', 'meter');
  const fill = el('span', 'meter-fill');
  fill.style.width = `${used}%`;
  meter.append(fill);
  node.append(el('span', 'usage-label', window.label), meter, el('span', 'usage-left', `${Math.round(100 - used)}% left`));
  if (window.resetsAt) node.append(el('span', 'usage-reset', `resets ${resetTime(window.resetsAt)}`));
  return node;
};

// The limits both sources usually report, drawn empty when a source reports none.
const PLACEHOLDER_WINDOWS = ['5h', 'Weekly'];

const renderPlaceholderWindow = (label) => {
  const node = el('div', 'usage-window usage-placeholder');
  node.append(el('span', 'usage-label', label), el('span', 'meter'), el('span', 'usage-left', '–'));
  return node;
};

/**
 * Usage for every installed source, in the filter's order. One with no answer yet gets an
 * empty entry, so it shows as a placeholder like one that answered without figures.
 */
const usageBySource = () =>
  Object.keys(SOURCE_LABELS)
    .filter((source) => !board.missingSources?.includes(source))
    .map((source) => board.usage?.find((usage) => usage.source === source) ?? { source, plan: null, windows: [], error: null });

const mostUsed = (windows) => windows.reduce((most, window) => (!most || window.usedPercent > most.usedPercent ? window : most), null);

/**
 * The limit to show in the top bar: the 5h one, unless a longer limit is nearly used up
 * (the meter's red level), since that one would then stop the session first.
 */
const headlineWindow = (windows) => {
  const fiveHour = windows.find((window) => window.label === '5h');
  const nearlyUsed = mostUsed(windows.filter((window) => window !== fiveHour && window.usedPercent >= 90));
  return nearlyUsed ?? fiveHour ?? mostUsed(windows);
};

/** Each source's headline limit, for the top bar; the full figures open below it. */
const renderUsageCompact = (usage) => {
  if (!usage.length) return [el('span', 'usage-note', 'Usage')];
  return usage.map((source) => {
    const part = el('span', 'usage-compact-source');
    part.append(el('span', `badge badge-${source.source}`, SOURCE_LABELS[source.source]));
    const shown = headlineWindow(source.windows);
    if (!shown) {
      part.title = `No usage data from ${SOURCE_LABELS[source.source]}`;
      part.append(el('span', 'usage-left usage-placeholder', '–%'));
      return part;
    }
    const used = Math.min(100, Math.max(0, shown.usedPercent));
    part.title = `${shown.label} limit: ${Math.round(100 - used)}% left`;
    part.classList.add(`level-${usageLevel(used)}`);
    part.append(el('span', 'usage-left', `${Math.round(100 - used)}%`));
    return part;
  });
};

const renderUsage = () => {
  const usage = usageBySource();
  const picker = $('#usage');
  picker.hidden = false;
  picker.querySelector('.usage-compact').replaceChildren(...renderUsageCompact(usage));
  const panel = picker.querySelector('.usage-panel');
  if (!usage.length) {
    panel.replaceChildren(el('span', 'usage-note', 'No usage data yet'));
    return;
  }
  panel.replaceChildren(
    ...usage.map((source) => {
      const row = el('div', 'usage-source');
      const heading = el('div', 'usage-heading');
      heading.append(el('span', `badge badge-${source.source}`, SOURCE_LABELS[source.source]));
      if (source.plan) heading.append(el('span', 'plan', source.plan));
      row.append(heading);
      if (source.windows.length) row.append(...source.windows.map((window) => renderUsageWindow(window, source.fetchedAt)));
      else {
        row.append(...PLACEHOLDER_WINDOWS.map(renderPlaceholderWindow));
        row.append(el('span', 'usage-note', source.error ?? (source.fetchedAt ? 'No limits reported' : 'No usage data yet')));
      }
      // Claude is read every 30 minutes, and kept when its rate-limited endpoint says no.
      if (source.windows.length && Date.now() - source.fetchedAt > 10 * 60_000) {
        row.append(el('span', 'usage-note', `as of ${timeAgo(source.fetchedAt)}`));
      }
      return row;
    }),
  );
};

/** The card the dragged one would land before at height `y`, or null for the end of the list. */
const cardBelow = (list, y) =>
  [...list.querySelectorAll('.card:not(.dragging)')].find((card) => {
    const box = card.getBoundingClientRect();
    return y < box.top + box.height / 2;
  }) ?? null;

const renderColumn = (column, cards) => {
  const section = el('section', 'column');
  section.dataset.column = column.id;
  const header = el('h2', 'column-title', column.title);
  if (!column.manualOrder) {
    const oldestFirst = view.oldestFirst.includes(column.id);
    const toggle = el('button', 'icon-button sort-toggle', oldestFirst ? 'Oldest ↑' : 'Newest ↓');
    toggle.type = 'button';
    toggle.title = `Sorted by last active, ${oldestFirst ? 'oldest' : 'newest'} first. Click to reverse.`;
    toggle.addEventListener('click', () => {
      view.oldestFirst = oldestFirst ? view.oldestFirst.filter((id) => id !== column.id) : [...view.oldestFirst, column.id];
      saveView();
      render();
    });
    header.append(toggle);
  }
  header.append(el('span', 'count', String(cards.length)));
  const list = el('div', 'cards');
  if (cards.length) list.append(...cards.map(renderCard));
  else list.append(el('p', 'empty', 'Nothing here'));
  section.append(header, list);
  return section;
};

/**
 * The column a card dragged to (x, y) drops into: the nearest one across, then down.
 * Below a short column still counts as that column, and the stacked phone layout,
 * where every column spans the width, goes by height.
 */
const columnAt = (x, y) => {
  let nearest = null;
  for (const section of document.querySelectorAll('.column')) {
    const box = section.getBoundingClientRect();
    const across = Math.max(box.left - x, 0, x - box.right);
    const down = Math.max(box.top - y, 0, y - box.bottom);
    if (!nearest || across < nearest.across || (across === nearest.across && down < nearest.down)) {
      nearest = { section, across, down };
    }
  }
  return nearest?.section ?? null;
};

const showDropTarget = (section) => {
  for (const other of document.querySelectorAll('.column.drop-target')) {
    if (other !== section) other.classList.remove('drop-target');
  }
  section?.classList.add('drop-target');
};

// The whole page takes drops, so a card dragged from far down reaches a short column.
document.addEventListener('dragover', (event) => {
  const dragged = $('.card.dragging');
  if (!dragged) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const section = columnAt(event.clientX, event.clientY);
  showDropTarget(section);
  if (!section || !board.columns.find((c) => c.id === section.dataset.column)?.manualOrder) {
    // A sorted column places the card itself, so the preview goes back to where it started.
    if (dragOrigin && (dragged.parentNode !== dragOrigin.list || dragged.nextElementSibling !== dragOrigin.next)) {
      dragOrigin.list.insertBefore(dragged, dragOrigin.next);
    }
    return;
  }
  // Moves the card itself to show where it will land; dragend re-renders from the board.
  const list = section.querySelector('.cards');
  const below = cardBelow(list, event.clientY);
  if (dragged.parentNode !== list || dragged.nextElementSibling !== below) {
    list.querySelector('.empty')?.remove();
    list.insertBefore(dragged, below);
  }
});
document.addEventListener('drop', (event) => {
  const dragged = $('.card.dragging');
  if (!dragged) return;
  event.preventDefault();
  const section = columnAt(event.clientX, event.clientY);
  showDropTarget(null);
  const id = event.dataTransfer.getData('text/plain');
  if (!section || !id) return;
  const column = board.columns.find((c) => c.id === section.dataset.column);
  if (!column) return;
  const ordered = column.manualOrder && dragged.parentNode === section.querySelector('.cards');
  place(id, column.id, ordered ? (dragged.nextElementSibling?.dataset.id ?? null) : undefined);
});

/** Holds still while a card is dragged or edited; `force` redraws an open editor. */
const render = ({ force = false } = {}) => {
  if (!board || dragging || (editing && !force)) return;
  renderFilters();
  renderUsage();
  // The server sends cards in the order the user dragged them into.
  const visible = board.cards.filter(matchesFilters);
  renderSummary(visible);
  // Same as the server, so a card dropped into Parked lands in place before the next poll.
  const byRecent = (a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
  const cardsIn = (column) => {
    const cards = visible.filter((card) => card.column === column.id);
    if (column.manualOrder) return cards;
    cards.sort(byRecent);
    return view.oldestFirst.includes(column.id) ? cards.reverse() : cards;
  };
  $('#board').replaceChildren(...board.columns.map((column) => renderColumn(column, cardsIn(column))));
  // A two-digit hour keeps the text one width, so the toolbar doesn't shift as the time changes.
  $('#updated').textContent = `Updated ${new Date(board.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  renderErrors();
};

const renderErrors = () => {
  const lines = (board?.errors ?? []).map((message) => el('p', '', message));
  if (actionError) {
    const line = el('p', '', actionError);
    const close = el('button', 'link-button errors-close', '×');
    close.type = 'button';
    close.title = 'Dismiss';
    close.setAttribute('aria-label', 'Dismiss');
    close.addEventListener('click', () => {
      actionError = null;
      renderErrors();
    });
    line.append(close);
    lines.push(line);
  }
  const errors = $('#errors');
  errors.hidden = lines.length === 0;
  errors.replaceChildren(...lines);
};

const showError = (message) => {
  actionError = message;
  renderErrors();
};

const poll = async () => {
  clearTimeout(pollTimer);
  try {
    const response = await fetch('/api/board');
    if (!response.ok) throw new Error(`Board request failed (${response.status})`);
    board = await response.json();
    $('#updated').classList.remove('stale');
    $('#updated').title = `Up to date. Refreshes every ${Math.round(board.pollIntervalMs / 1000)}s.`;
    render();
    watchForChanges();
  } catch (error) {
    // The next poll retries, so this flags the time as stale rather than raising the banner.
    const updated = $('#updated');
    if (!board) updated.textContent = 'Not loaded';
    updated.classList.add('stale');
    updated.title = `Could not load sessions: ${error.message}. Retrying every ${Math.round((board?.pollIntervalMs ?? 5000) / 1000)}s.`;
  }
  pollTimer = setTimeout(poll, board?.pollIntervalMs ?? 5000);
};

/** With `npm run dev`: reloads the page when the server restarts or a file in public/ changes. */
let watchingForChanges = false;
const watchForChanges = () => {
  if (watchingForChanges || !board?.liveReload) return;
  watchingForChanges = true;
  const events = new EventSource('/api/live-reload');
  let connected = false;
  events.addEventListener('open', () => {
    if (connected) location.reload();
    connected = true;
  });
  events.addEventListener('reload', () => location.reload());
};

/** Sends JSON to the board's API; throws the server's error message when it refuses. */
const send = async (method, url, body) => {
  const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `request failed (${response.status})`);
};

/**
 * Moves a card to a column. With `before` (a card id, or null for the end) it also
 * reorders the column and saves its full order, hidden cards included.
 */
const place = async (id, column, before) => {
  const card = board?.cards.find((c) => c.id === id);
  let order;
  if (card) {
    card.column = column;
    if (before !== undefined) {
      board.cards.splice(board.cards.indexOf(card), 1);
      const index = board.cards.findIndex((c) => c.id === before);
      board.cards.splice(index === -1 ? board.cards.length : index, 0, card);
      order = board.cards.filter((c) => c.column === column).map((c) => c.id);
    }
    render();
  }
  try {
    await send('PUT', '/api/placement', { id, column, order });
  } catch (error) {
    showError(`Saving failed: ${error.message}`);
  }
  poll();
};

const openSession = async (id) => {
  try {
    await send('POST', '/api/open', { id });
  } catch (error) {
    showError(`Opening failed: ${error.message}`);
  }
};

const saveTicket = async (card, key) => {
  const changed = key !== card.ticket;
  card.ticket = key;
  stopEditing();
  if (!changed) return;
  try {
    await send('PUT', '/api/ticket', { id: card.id, key });
  } catch (error) {
    showError(`Saving failed: ${error.message}`);
  }
  poll();
};

for (const [selector, key] of [['#filter-repo', 'hiddenRepos'], ['#filter-source', 'hiddenSources'], ['#filter-ticket', 'hiddenTickets']]) {
  const picker = $(selector);
  const hide = (values) => {
    view[key] = values;
    saveView();
    render();
  };
  const values = (boxes) => [...boxes].map((box) => box.value);
  picker.addEventListener('change', () => hide(values(picker.querySelectorAll('input:not(:checked)'))));
  picker.addEventListener('click', (event) => {
    const only = event.target.closest('.multi-select-only');
    if (only) hide(values(picker.querySelectorAll('input')).filter((value) => value !== only.dataset.value));
  });
  picker.querySelector('.multi-select-clear').addEventListener('click', () => hide([]));
}
// The filters and the usage panel close like a select: on Escape, or a click elsewhere.
for (const picker of document.querySelectorAll('.multi-select')) {
  picker.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !picker.open) return;
    picker.open = false;
    picker.querySelector('summary').focus();
  });
}
document.addEventListener('click', (event) => {
  for (const picker of document.querySelectorAll('.multi-select[open]')) {
    if (!picker.contains(event.target)) picker.open = false;
  }
});

poll();
