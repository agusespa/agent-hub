const $ = (selector) => document.querySelector(selector);

const STATUS_LABELS = { working: 'Working', waiting: 'Awaiting input', idle: 'Idle' };
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
/** Why the last board load failed, until one succeeds; the next poll retries on its own. */
let loadError = null;
/** Each repo's hue, from its place in the sorted repo list: far apart, and steady until a repo is added. */
let repoHues = new Map();
/** Notes are persisted by the local app; only edits awaiting autosave live in memory. */
const noteDrafts = new Map();
let selectedCard = null;
/** The title being edited in place: its card and the text to restore on Escape. */
let titleEdit = null;
let savingTitle = null;

/** The ticket filter's value for cards without one; ticket IDs are upper case, so it never clashes. */
const NO_TICKET = 'none';

/**
 * The repos, sources and tickets unticked in the filters, so new ones show, and the
 * last-active columns flipped to oldest first.
 */
const view = { hiddenRepos: [], hiddenSources: [], hiddenTickets: [], oldestFirst: [] };
let viewLoaded = false;
let pendingView = {};
let savingView = null;

const flushView = () => {
  if (savingView) return savingView;
  if (!Object.keys(pendingView).length) return Promise.resolve(true);
  const patch = pendingView;
  pendingView = {};
  savingView = (async () => {
    let saved = false;
    try {
      await send('PUT', '/api/view', patch);
      saved = true;
    } catch (error) {
      pendingView = { ...patch, ...pendingView };
      showError(`Saving filters failed: ${error.message}. Your choices remain open; changing a filter retries.`);
    } finally {
      savingView = null;
      if (saved && Object.keys(pendingView).length) void flushView();
    }
    return saved;
  })();
  return savingView;
};

const saveView = (key) => {
  pendingView[key] = [...view[key]];
  void flushView();
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

/**
 * The time a card shows and Parked and Done sort by: the user's last prompt, or when the
 * session started where Live status saw none. Last active moves even with no new prompt.
 */
const cardTime = (card) =>
  card.lastPromptAt
    ? { at: card.lastPromptAt, label: 'Your last prompt' }
    : card.createdAt
      ? { at: card.createdAt, label: 'Started' }
      : { at: card.lastActiveAt, label: 'Last active' };

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
  renderDetails();
  $('#details-ticket .ticket-input')?.select();
};

const stopEditing = () => {
  editing = null;
  render();
  $('#details-ticket button')?.focus();
};

/** Enter saves, an empty key removes it; Escape or Cancel discards the edit. */
const renderTicketEditor = (card) => {
  const form = el('form', 'ticket-editor');
  const input = el('input', 'ticket-input');
  Object.assign(input, { value: editing.value, placeholder: 'PROJ-1234 or ticket link', maxLength: 500, spellcheck: false, autocomplete: 'off' });
  input.setAttribute('aria-label', 'Ticket ID or link');
  input.title = 'Enter a ticket ID or link. Clear the field to remove the ticket.';
  input.addEventListener('input', () => {
    editing.value = input.value;
    input.setCustomValidity('');
  });
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      stopEditing();
    }
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
  const save = el('button', 'details-action', 'Save');
  save.type = 'submit';
  const cancel = el('button', 'details-action', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', stopEditing);
  form.append(input, save, cancel);
  return form;
};

/** The ticket and its change button, the editor, or an add button when there is none. */
const renderDetailsTicket = (card) => {
  if (editing?.id === card.id) return [renderTicketEditor(card)];
  const button = (className, text, title) => {
    const node = el('button', className, text);
    Object.assign(node, { type: 'button', title });
    node.setAttribute('aria-label', title);
    node.addEventListener('click', () => startEditing(card));
    return node;
  };
  if (!card.ticket) return [button('ticket-add', '+', 'Add a ticket')];
  return [el('span', 'tag ticket', card.ticket), button('icon-button ticket-change', '✎', 'Change or remove the ticket')];
};

const renderNotesStatus = () => {
  if (!selectedCard) return;
  const draft = noteDrafts.get(selectedCard.id);
  const status = $('#notes-status');
  status.textContent = draft?.error ? 'Couldn’t save' : draft?.saving ? 'Saving…' : draft ? 'Unsaved changes' : 'Saved';
  status.classList.toggle('save-error', Boolean(draft?.error));
  $('#notes-retry').hidden = !draft?.error;
};

/** Save requests for a given card run in order, even when typing continues during a save. */
const saveNotes = (id) => {
  const draft = noteDrafts.get(id);
  if (!draft) return Promise.resolve(true);
  if (draft.saving) return draft.saving;
  clearTimeout(draft.timer);
  const text = draft.text;
  draft.error = null;
  draft.saving = (async () => {
    let saved = false;
    try {
      await send('PUT', '/api/notes', { id, text });
      saved = true;
      const card = board?.cards.find((candidate) => candidate.id === id);
      if (card) card.notes = text;
      if (selectedCard?.id === id) selectedCard.notes = text;
      if (draft.text === text) {
        clearTimeout(draft.timer);
        noteDrafts.delete(id);
      }
    } catch (error) {
      draft.error = error.message;
      showError(`Saving notes failed: ${error.message}. Your edits are still open; retry to save them.`);
    } finally {
      draft.saving = null;
      renderNotesStatus();
      if (saved && noteDrafts.has(id)) void saveNotes(id);
      render();
    }
    return saved;
  })();
  renderNotesStatus();
  return draft.saving;
};

// Electron calls this before closing its window, while the local file-writing server is still running.
window.agentHub = {
  async flushPendingChanges() {
    if (savingTitle && !(await savingTitle)) return false;
    while (noteDrafts.size || savingView || Object.keys(pendingView).length) {
      const saved = await Promise.all([...noteDrafts.keys()].map(saveNotes).concat(flushView()));
      if (saved.some((result) => !result)) return false;
    }
    return true;
  },
};

const renderDetails = () => {
  if (!selectedCard) return;
  const current = board?.cards.find((card) => card.id === selectedCard.id);
  if (current) selectedCard = { ...current };
  const card = selectedCard;
  const title = $('#details-title');
  // Polls must not replace text being typed, or a saved title before its save lands.
  if (!titleEdit && !savingTitle) title.textContent = card.title;
  if (card.renameId) {
    title.contentEditable = 'plaintext-only';
    title.setAttribute('role', 'textbox');
    title.setAttribute('aria-label', 'Session title');
  } else {
    title.removeAttribute('contenteditable');
    title.removeAttribute('role');
    title.removeAttribute('aria-label');
  }
  const badges = [el('span', `badge badge-${card.source}`, SOURCE_LABELS[card.source])];
  if (card.liveStatus) badges.push(el('span', `status status-${card.liveStatus}`, STATUS_LABELS[card.liveStatus]));
  $('#details-badges').replaceChildren(...badges);
  const metadata = [
    ['project', card.repo],
    ['folder', card.cwd ?? 'No folder'],
    ['branch', card.branch ?? 'Not reported'],
    ['column', board?.columns.find((column) => column.id === card.column)?.title ?? card.column],
  ];
  for (const [field, value] of metadata) $(`#details-${field}`).textContent = value;
  // Keep the input, caret and focused buttons mounted through polls and notes autosaves.
  const ticket = $('#details-ticket');
  const ticketState = JSON.stringify([card.id, editing?.id === card.id ? 'editing' : card.ticket]);
  if (ticket.dataset.state !== ticketState) {
    ticket.dataset.state = ticketState;
    ticket.replaceChildren(...renderDetailsTicket(card));
  }
  const sessionButton = $('#details-session');
  sessionButton.hidden = !card.openId;
  sessionButton.textContent = `Open in ${SOURCE_LABELS[card.source]} ↗`;
  $('#details-editor').hidden = !card.cwd;
  // The textarea stays mounted; polling must not replace its value or move the caret while editing.
  const textarea = $('#details-notes');
  if (!noteDrafts.has(card.id) && document.activeElement !== textarea) textarea.value = card.notes ?? '';
  renderNotesStatus();
};

const openDetails = (card) => {
  if (selectedCard && selectedCard.id !== card.id) void saveNotes(selectedCard.id);
  titleEdit = null;
  editing = null;
  selectedCard = { ...card };
  $('#details-notes').value = noteDrafts.get(card.id)?.text ?? card.notes ?? '';
  renderDetails();
  if (!$('#card-details').open) $('#card-details').showModal();
  $('#details-close').focus();
};

const closeDetails = () => {
  if (!selectedCard) return;
  const id = selectedCard.id;
  void saveNotes(id);
  // A title being typed saves on the blur that closing causes, like clicking away.
  editing = null;
  selectedCard = null;
  $('#card-details').close();
  [...document.querySelectorAll('.card')].find((card) => card.dataset.id === id)?.querySelector('.card-title-button')?.focus();
};

const saveTitle = (id, title, before) => {
  savingTitle = (async () => {
    try {
      const saved = await send('PUT', '/api/title', { id, title });
      const card = board?.cards.find((candidate) => candidate.id === id);
      if (card) card.title = saved.title;
      if (selectedCard?.id === id) selectedCard.title = saved.title;
      return true;
    } catch (error) {
      if (selectedCard?.id === id && !titleEdit) $('#details-title').textContent = before;
      showError(`Renaming session failed: ${error.message}`);
      return false;
    } finally {
      savingTitle = null;
      render();
    }
  })();
};

/** Enter or clicking away saves; Escape restores the title. Empty or unchanged titles do nothing. */
$('#details-title').addEventListener('focus', (event) => {
  if (selectedCard?.renameId) titleEdit = { id: selectedCard.id, before: event.target.textContent };
});
$('#details-title').addEventListener('keydown', (event) => {
  if (!titleEdit) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    event.target.blur();
  } else if (event.key === 'Escape') {
    // Restores the title instead of closing the dialog.
    event.preventDefault();
    event.stopPropagation();
    event.target.textContent = titleEdit.before;
    titleEdit = null;
    event.target.blur();
  }
});
$('#details-title').addEventListener('blur', (event) => {
  if (!titleEdit) return;
  const { id, before } = titleEdit;
  titleEdit = null;
  const title = event.target.textContent.replace(/\s+/g, ' ').trim();
  if (!title || title === before) {
    event.target.textContent = before;
    return;
  }
  if (title.length > 200 || /[\p{Cc}\p{Cf}]/u.test(title)) {
    event.target.textContent = before;
    showError('Titles can be up to 200 characters, without control characters');
    return;
  }
  event.target.textContent = title;
  saveTitle(id, title, before);
});

$('#details-close').addEventListener('click', closeDetails);
$('#details-session').addEventListener('click', () => selectedCard && openSession(selectedCard.id));
$('#details-editor').addEventListener('click', () => selectedCard && openSession(selectedCard.id, 'vscode'));
$('#notes-retry').addEventListener('click', () => selectedCard && saveNotes(selectedCard.id));
$('#details-notes').addEventListener('input', (event) => {
  if (!selectedCard) return;
  const id = selectedCard.id;
  const draft = noteDrafts.get(id) ?? { text: '', saving: false, error: null };
  clearTimeout(draft.timer);
  draft.text = event.target.value;
  draft.error = null;
  noteDrafts.set(id, draft);
  draft.timer = setTimeout(() => saveNotes(id), 400);
  renderNotesStatus();
});
$('#details-notes').addEventListener('blur', () => selectedCard && saveNotes(selectedCard.id));
$('#card-details').addEventListener('cancel', (event) => {
  event.preventDefault();
  closeDetails();
});
$('#card-details').addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const controls = [...$('#card-details').querySelectorAll('[contenteditable], button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')]
    .filter((control) => control.getClientRects().length);
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
});
const outsideDetails = (event) => {
  const box = $('#card-details').getBoundingClientRect();
  return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
};
let backdropPointerDown = false;
$('#card-details').addEventListener('pointerdown', (event) => {
  backdropPointerDown = event.target === $('#card-details') && outsideDetails(event);
});
$('#card-details').addEventListener('click', (event) => {
  if (backdropPointerDown && event.target === $('#card-details') && outsideDetails(event)) closeDetails();
  backdropPointerDown = false;
});
// Give pending edits a final local save when the preview reloads or the Electron window closes.
window.addEventListener('pagehide', () => {
  for (const [id, draft] of noteDrafts) {
    void fetch('/api/notes', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, text: draft.text }), keepalive: true,
    }).catch(() => {});
  }
  if (Object.keys(pendingView).length) {
    void fetch('/api/view', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pendingView), keepalive: true,
    }).catch(() => {});
  }
});

const renderCard = (card) => {
  const node = el('article', `card source-${card.source}`);
  node.draggable = true;
  node.dataset.id = card.id;
  let dragged = false;
  node.addEventListener('pointerdown', () => { dragged = false; });
  node.addEventListener('click', (event) => {
    // Buttons and expandable warnings keep their own actions. A completed drag
    // must not turn into a click that opens the session's details.
    if (dragged || event.target.closest('button, a, input, textarea, select, details')) return;
    openDetails(card);
  });
  node.addEventListener('dragstart', (event) => {
    dragged = true;
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
  const actions = el('div', 'card-actions');
  if (card.cwd) {
    const open = el('button', 'icon-button open-project');
    Object.assign(open, { type: 'button', title: `Open project in VS Code\n${card.cwd}` });
    open.setAttribute('aria-label', 'Open project in VS Code');
    const icon = el('span', 'editor-icon');
    icon.setAttribute('aria-hidden', 'true');
    open.append(icon);
    open.addEventListener('click', () => openSession(card.id, 'vscode'));
    actions.append(open);
  }
  if (card.openId) {
    const open = el('button', 'icon-button open-session', '↗');
    Object.assign(open, { type: 'button', title: `Open in ${SOURCE_LABELS[card.source]}` });
    open.setAttribute('aria-label', `Open in ${SOURCE_LABELS[card.source]}`);
    open.addEventListener('click', () => openSession(card.id));
    actions.append(open);
  }
  if (actions.children.length) top.append(actions);
  const title = el('h3', 'title');
  const titleButton = el('button', 'card-title-button', card.title);
  titleButton.type = 'button';
  titleButton.setAttribute('aria-haspopup', 'dialog');
  titleButton.setAttribute('aria-controls', 'card-details');
  titleButton.addEventListener('click', () => {
    if (!dragged) openDetails(card);
  });
  title.append(titleButton);
  node.append(top, title);
  if (card.ticket) {
    const ticket = el('div', 'card-ticket');
    ticket.append(el('span', 'tag ticket', card.ticket));
    node.append(ticket);
  }

  const conflicts = (board.conflicts ?? []).filter((conflict) => conflict.sessionIds.includes(card.id));
  if (conflicts.length) {
    // Sharing a workspace is only a possible issue; observed edits to the same files are the real one.
    const overlapping = conflicts.some((conflict) => conflict.files.length > 0);
    const warning = el('details', `conflict-warning${overlapping ? ' conflict-overlap' : ''}`);
    warning.append(el('summary', '', overlapping ? '⚠ Overlapping file edits' : '⚠ Possible concurrent work'));
    for (const conflict of conflicts) {
      const other = board.cards.find((candidate) => candidate.id === conflict.sessionIds.find((id) => id !== card.id));
      const description = el('p', '', `${conflict.kind === 'worktree' ? 'Same worktree' : `Same branch (${conflict.branch})`}: ${other ? `${SOURCE_LABELS[other.source]} · ${other.title}` : 'another working session'}`);
      description.append(el('span', 'conflict-location', conflict.location));
      if (conflict.files.length > 0) description.append(el('span', 'conflict-location', `Observed edits to the same files:\n${conflict.files.join('\n')}`));
      else description.append(el('span', 'conflict-note', 'No edits to the same files so far. You get an alert if that changes.'));
      if (other?.openId) {
        const open = el('button', 'link-button', `Open in ${SOURCE_LABELS[other.source]} ↗`);
        open.type = 'button';
        open.addEventListener('click', () => openSession(other.id));
        description.append(open);
      }
      warning.append(description);
    }
    // Preserve an expanded warning through the board's regular redraws.
    warning.open = [...document.querySelectorAll('.card')].find((old) => old.dataset.id === card.id)
      ?.querySelector('.conflict-warning')?.open ?? false;
    node.append(warning);
  }

  const tags = el('div', 'tags');
  tags.append(el('span', `badge badge-${card.source}`, SOURCE_LABELS[card.source]));
  if (card.liveStatus) {
    tags.append(el('span', `status status-${card.liveStatus}`, STATUS_LABELS[card.liveStatus]));
  }
  if ((noteDrafts.get(card.id)?.text ?? card.notes ?? '').trim()) {
    const notes = el('span', 'notes-indicator', '▤');
    notes.title = 'Has notes';
    notes.setAttribute('role', 'img');
    notes.setAttribute('aria-label', 'Has notes');
    tags.append(notes);
  }
  const { at, label } = cardTime(card);
  const time = el('span', 'time', timeAgo(at));
  if (at) time.title = `${label} ${new Date(at).toLocaleString()}`;
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

const DAY_MS = 24 * 60 * 60_000;

/** Why a source has no figures: its read failed, it has no plan limits, or it has not answered yet. */
const noUsageReason = (source) => source.error ?? (source.fetchedAt ? 'No limits reported' : 'No usage data yet');

/**
 * One state for a source's limits, worst first: a limit used up, one running low (the
 * meter's yellow or red), a weekly limit with room left that resets within a day (so
 * it is worth spending), or all fine. Unknown, with the reason, when there are no figures.
 */
const usageState = ({ windows, ...source }) => {
  if (!windows.length) return { state: 'unknown', text: noUsageReason(source) };
  const out = windows.filter((window) => window.usedPercent >= 100);
  if (out.length) return { state: 'out', text: `Used up: ${out.map((window) => window.label).join(', ')}` };
  const low = windows.filter((window) => usageLevel(window.usedPercent) !== 'low');
  if (low.length) return { state: 'low', text: `Running low: ${low.map((window) => `${window.label} ${Math.round(100 - window.usedPercent)}% left`).join(', ')}` };
  const spare = windows.filter((window) => window.label.startsWith('Weekly') && window.resetsAt && window.resetsAt - Date.now() < DAY_MS);
  if (spare.length) {
    return { state: 'spare', text: `Use it before it resets: ${spare.map((window) => `${window.label} ${Math.round(100 - window.usedPercent)}% left, resets ${resetTime(window.resetsAt)}`).join(', ')}` };
  }
  return { state: 'ok', text: 'All limits fine' };
};

/** A dot, its glyph and colour set by the state's class. */
const renderUsageIcon = ({ state, text }) => {
  const icon = el('span', `usage-icon usage-${state}`);
  icon.title = text;
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', text);
  return icon;
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
      part.prepend(renderUsageIcon(usageState(source)));
      part.append(el('span', 'usage-left usage-placeholder', '–%'));
      return part;
    }
    const state = usageState(source);
    part.prepend(renderUsageIcon(state));
    const used = Math.min(100, Math.max(0, shown.usedPercent));
    part.title = `${shown.label} limit: ${Math.round(100 - used)}% left\n${state.text}`;
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
      // With no figures the heading says only that; why is in its title, on hover.
      const state = usageState(source);
      const label = el('span', `usage-state usage-${state.state}`, state.state === 'unknown' ? 'No usage data' : state.text);
      if (state.state === 'unknown') label.title = state.text;
      heading.append(renderUsageIcon(state), label);
      row.append(heading);
      if (source.windows.length) row.append(...source.windows.map((window) => renderUsageWindow(window, source.fetchedAt)));
      else row.append(...PLACEHOLDER_WINDOWS.map(renderPlaceholderWindow));
      // Claude is read every 30 minutes, and kept when its rate-limited endpoint says no.
      if (source.windows.length && Date.now() - source.fetchedAt > 10 * 60_000) {
        row.append(el('span', 'usage-note', `as of ${timeAgo(source.fetchedAt)}`));
      }
      return row;
    }),
  );
};

const HOOK_CONFIGS = { claude: '~/.claude/settings.json', codex: '~/.codex/hooks.json' };
/** The hooks state the panel was drawn for, so a poll does not redraw it under the pointer. */
let hooksDrawn = null;
let hooksSaving = false;

/** The live status menu: whether the board's hooks are on, and the button that turns them on or off. */
const renderHooks = () => {
  const picker = $('#hooks');
  const sources = Object.keys(SOURCE_LABELS).filter((source) => (board.hooks?.[source] ?? 'unavailable') !== 'unavailable');
  picker.hidden = !sources.length;
  const on = sources.filter((source) => board.hooks[source] === 'on');
  // Whether events arrive says more than the configs do: Codex skips hooks it has not been told to trust.
  const events = on.map((source) => {
    const at = board.lastHookEvents?.[source];
    if (at) return el('p', 'usage-note', `${SOURCE_LABELS[source]}: last event ${timeAgo(at)}`);
    const hint = source === 'codex' ? 'If a Codex session is running, trust the hooks: run /hooks in the Codex CLI.' : 'A session started before they were turned on needs a restart.';
    return el('p', 'usage-note', `${SOURCE_LABELS[source]}: no events in the last 12 hours. ${hint}`);
  });
  const drawn = JSON.stringify([board.hooks, hooksSaving, events.map((line) => line.textContent)]);
  if (!sources.length || drawn === hooksDrawn) return;
  hooksDrawn = drawn;
  const allOn = on.length === sources.length;
  picker.querySelector('.hooks-value').textContent = allOn ? 'Live status on' : on.length ? 'Live status partly on' : 'Live status off';
  const names = (list) => list.map((source) => SOURCE_LABELS[source]).join(' and ');
  const lines = allOn
    ? [
        el('p', '', `On for ${names(on)}. New sessions use the hooks; running ones may need a restart.`),
        ...events,
      ]
    : [
        el('p', '', 'Hooks tell the board as soon as a session starts working, needs you or stops, and give Codex sessions a status, which the board cannot read otherwise.'),
        el('p', 'usage-note', `Adds the board's hooks to ${sources.map((source) => HOOK_CONFIGS[source]).join(' and ')}. They pass on only the session id: prompts, tool details and transcripts are not read.`),
        ...events,
      ];
  const button = el('button', 'hooks-button', hooksSaving ? 'Saving…' : allOn ? 'Turn off' : 'Turn on');
  Object.assign(button, { type: 'button', disabled: hooksSaving });
  if (allOn) button.title = "Removes only the board's hooks";
  button.addEventListener('click', () => setHooks(!allOn));
  picker.querySelector('.hooks-panel').replaceChildren(...lines, button);
};

const setHooks = async (on) => {
  hooksSaving = true;
  renderHooks();
  try {
    await send('PUT', '/api/hooks', { on });
  } catch (error) {
    showError(`Turning live status ${on ? 'on' : 'off'} failed: ${error.message}`);
  }
  hooksSaving = false;
  await poll();
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
  header.append(el('span', 'count', String(cards.length)));
  if (column.manualOrder) {
    const hint = el('span', 'sort-toggle sort-manual', '↑↓');
    hint.dataset.tip = 'Custom order: drag cards to reorder them.';
    hint.setAttribute('aria-label', hint.dataset.tip);
    header.append(hint);
  } else {
    const oldestFirst = view.oldestFirst.includes(column.id);
    const toggle = el('button', 'icon-button sort-toggle', oldestFirst ? '↑' : '↓');
    toggle.type = 'button';
    toggle.dataset.tip = `Sorted by your last prompt, ${oldestFirst ? 'oldest' : 'newest'} first, or by when the session started if Live status saw none. Click for ${oldestFirst ? 'newest' : 'oldest'} first.`;
    toggle.setAttribute('aria-label', toggle.dataset.tip);
    toggle.addEventListener('click', () => {
      view.oldestFirst = oldestFirst ? view.oldestFirst.filter((id) => id !== column.id) : [...view.oldestFirst, column.id];
      saveView('oldestFirst');
      render();
    });
    header.append(toggle);
  }
  const list = el('div', 'cards');
  if (cards.length) list.append(...cards.map(renderCard));
  else list.append(el('p', 'empty', 'Nothing here'));
  section.append(header, list);
  return section;
};

/**
 * The column a card dragged to (x, y) drops into: the nearest one across, then down.
 * A gap between columns or the board's edge still counts as the nearest column, and
 * the stacked phone layout, where every column spans the width, goes by height.
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

// The whole page takes drops, so crossing the gap between columns doesn't flicker the target.
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

/**
 * Puts redrawn columns on the page. A header that hasn't changed stays, so a hovered
 * sort tooltip doesn't close and reopen on every poll.
 */
const updateColumns = (sections) => {
  const focused = document.activeElement;
  const focusedId = focused?.closest('.card')?.dataset.id;
  const focusSelector = ['.card-title-button', '.open-session', '.open-project']
    .find((selector) => focused?.matches(selector));
  const current = [...$('#board').children];
  if (current.length !== sections.length || sections.some((section, i) => section.dataset.column !== current[i].dataset.column)) {
    $('#board').replaceChildren(...sections);
    return;
  }
  sections.forEach((section, i) => {
    const [header, list] = section.children;
    const [oldHeader, oldList] = current[i].children;
    if (oldHeader.outerHTML !== header.outerHTML) oldHeader.replaceWith(header);
    // Each column scrolls on its own, so a poll keeps the place you scrolled to.
    const { scrollTop } = oldList;
    oldList.replaceWith(list);
    list.scrollTop = scrollTop;
  });
  if (focusedId && focusSelector) {
    [...document.querySelectorAll('.card')].find((card) => card.dataset.id === focusedId)
      ?.querySelector(focusSelector)?.focus({ preventScroll: true });
  }
};

/** Holds still while a card is dragged; details keep their editor mounted separately. */
const render = () => {
  if (!board || dragging) return;
  renderFilters();
  renderUsage();
  renderHooks();
  // The server sends cards in the order the user dragged them into.
  const visible = board.cards.filter(matchesFilters);
  renderSummary(visible);
  // Same as the server, so a card dropped into Parked lands in place before the next poll.
  const byNewest = (a, b) => (cardTime(b).at ?? 0) - (cardTime(a).at ?? 0);
  const cardsIn = (column) => {
    const cards = visible.filter((card) => card.column === column.id);
    if (column.manualOrder) return cards;
    cards.sort(byNewest);
    return view.oldestFirst.includes(column.id) ? cards.reverse() : cards;
  };
  updateColumns(board.columns.map((column) => renderColumn(column, cardsIn(column))));
  renderErrors();
  renderDetails();
};

const renderErrors = () => {
  const lines = (board?.errors ?? []).map((message) => el('p', '', message));
  if (loadError) lines.unshift(el('p', '', loadError));
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
    if (!viewLoaded) {
      for (const key of Object.keys(view)) view[key] = board.view?.[key] ?? [];
      viewLoaded = true;
    }
    loadError = null;
    render();
    watchForChanges();
  } catch (error) {
    const since = board ? ` Not updated since ${new Date(board.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : '';
    loadError = `Could not load sessions: ${error.message}.${since} Retrying every ${Math.round((board?.pollIntervalMs ?? 5000) / 1000)}s.`;
    renderErrors();
  }
  pollTimer = setTimeout(poll, board?.pollIntervalMs ?? 5000);
};

/**
 * Loads the board as soon as a hook reports a session's status. With `npm run dev`, also
 * reloads the page when the server restarts or a file in public/ changes.
 */
let watchingForChanges = false;
const watchForChanges = () => {
  if (watchingForChanges || !board) return;
  watchingForChanges = true;
  const events = new EventSource('/api/events');
  let connected = false;
  events.addEventListener('open', () => {
    if (connected && board.liveReload) location.reload();
    connected = true;
  });
  events.addEventListener('board', () => poll());
  events.addEventListener('reload', () => location.reload());
};

/** Sends JSON to the board's API; throws the server's error message when it refuses. */
const send = async (method, url, body) => {
  const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `request failed (${response.status})`);
  return response.json();
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

const openSession = async (id, target = 'session') => {
  try {
    await send('POST', '/api/open', { id, target });
  } catch (error) {
    showError(`Opening failed: ${error.message}`);
  }
};

const saveTicket = async (card, key) => {
  const changed = key !== card.ticket;
  card.ticket = key;
  const current = board?.cards.find((candidate) => candidate.id === card.id);
  if (current) current.ticket = key;
  if (selectedCard?.id === card.id) selectedCard.ticket = key;
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
    saveView(key);
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
