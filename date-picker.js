// A progressively enhanced date field. Values stay ISO dates for reporting.
const fields = new WeakSet();
let active = null;
let sequence = 0;
const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
function parse(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && iso(date) === value ? date : null;
}
const longDate = date => date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
function valid(input) {
  const value = input.value, date = parse(value);
  let error = value && !date ? 'Enter a valid date as YYYY-MM-DD.' : '';
  if (date && input.min && value < input.min) error = `Choose ${input.min} or later.`;
  if (date && input.max && value > input.max) error = `Choose ${input.max} or earlier.`;
  input.setCustomValidity(error);
  return !error;
}
function close(restore = false) {
  if (!active) return;
  const { popup, trigger } = active;
  active = null;
  popup.remove();
  trigger.setAttribute('aria-expanded', 'false');
  if (restore && trigger.isConnected) trigger.focus();
}
function position() {
  if (!active) return;
  const { popup, trigger } = active, rect = trigger.parentElement.getBoundingClientRect();
  const width = Math.min(328, window.innerWidth - 24);
  popup.style.width = `${width}px`;
  popup.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
  const height = popup.getBoundingClientRect().height;
  popup.style.top = `${Math.max(12, rect.bottom + height + 8 < window.innerHeight ? rect.bottom + 8 : rect.top - height - 8)}px`;
  popup.style.maxHeight = `${window.innerHeight - 24}px`;
}
function allowed(date) {
  const value = iso(date);
  return (!active.input.min || value >= active.input.min) && (!active.input.max || value <= active.input.max);
}
function focusDate(date) {
  if (!active) return;
  const min = parse(active.input.min), max = parse(active.input.max);
  if (min && date < min) date = min;
  if (max && date > max) date = max;
  active.focused = date;
  active.month = new Date(date.getFullYear(), date.getMonth(), 1, 12);
  render();
  active.popup.querySelector('[tabindex="0"]')?.focus();
}
function shiftMonth(date, amount) {
  const result = new Date(date.getFullYear(), date.getMonth() + amount, 1, 12);
  result.setDate(Math.min(date.getDate(), new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate()));
  return result;
}
function choose(date) {
  const input = active.input;
  input.value = iso(date);
  input.setCustomValidity('');
  close(true);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  valid(input);
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function render() {
  const { input, popup, month, focused } = active;
  const title = month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const previousLast = new Date(month.getFullYear(), month.getMonth(), 0, 12);
  const nextFirst = new Date(month.getFullYear(), month.getMonth() + 1, 1, 12);
  popup.replaceChildren();
  const header = document.createElement('div');
  header.className = 'sp-date-header';
  const heading = document.createElement('strong');
  heading.id = `${popup.id}-heading`;
  heading.textContent = title;
  heading.setAttribute('aria-live', 'polite');
  for (const [text, label, amount, disabled] of [
    ['‹', 'Previous month', -1, input.min && iso(previousLast) < input.min],
    ['›', 'Next month', 1, input.max && iso(nextFirst) > input.max],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sp-date-nav';
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.disabled = Boolean(disabled);
    button.addEventListener('click', () => focusDate(shiftMonth(active.focused, amount)));
    if (amount === -1) header.append(button, heading); else header.append(button);
  }
  popup.append(header);
  const weekdays = document.createElement('div');
  weekdays.className = 'sp-date-weekdays';
  weekdays.setAttribute('aria-hidden', 'true');
  for (const day of ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']) {
    const span = document.createElement('span'); span.textContent = day; weekdays.append(span);
  }
  popup.append(weekdays);
  const grid = document.createElement('div');
  grid.className = 'sp-date-grid';
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-labelledby', heading.id);
  const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
  const offset = (first.getDay() + 6) % 7;
  const length = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  for (let i = 0; i < offset; i++) {
    const spacer = document.createElement('span'); spacer.setAttribute('aria-hidden', 'true'); grid.append(spacer);
  }
  for (let day = 1; day <= length; day++) {
    const date = new Date(month.getFullYear(), month.getMonth(), day, 12);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sp-date-day';
    button.textContent = String(day);
    button.setAttribute('aria-label', longDate(date));
    button.setAttribute('aria-pressed', String(iso(date) === input.value));
    if (iso(date) === iso(new Date())) button.setAttribute('aria-current', 'date');
    button.disabled = !allowed(date);
    button.tabIndex = iso(date) === iso(focused) ? 0 : -1;
    button.addEventListener('click', () => choose(date));
    button.addEventListener('keydown', event => {
      let next = new Date(date);
      const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (event.key in steps) next.setDate(next.getDate() + steps[event.key]);
      else if (event.key === 'Home') next.setDate(next.getDate() - (next.getDay() + 6) % 7);
      else if (event.key === 'End') next.setDate(next.getDate() + 6 - (next.getDay() + 6) % 7);
      else if (event.key === 'PageUp' || event.key === 'PageDown') next = shiftMonth(next, (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1));
      else return;
      event.preventDefault(); focusDate(next);
    });
    grid.append(button);
  }
  popup.append(grid);
  const footer = document.createElement('div');
  footer.className = 'sp-date-footer';
  const hint = document.createElement('span');
  hint.textContent = 'Or type YYYY-MM-DD';
  const done = document.createElement('button');
  done.type = 'button'; done.textContent = 'Close';
  done.addEventListener('click', () => close(true));
  footer.append(hint, done); popup.append(footer);
  position();
}
function open(input, trigger) {
  if (active?.trigger === trigger) { close(true); return; }
  close(); window.SPSelect?.close();
  const popup = document.createElement('div');
  popup.id = trigger.getAttribute('aria-controls');
  popup.className = 'sp-date-popup';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', `${trigger.dataset.label} calendar`);
  popup.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const inside = [...popup.querySelectorAll('button:not(:disabled)')].filter(el => el.tabIndex >= 0);
    if (event.target !== (event.shiftKey ? inside[0] : inside.at(-1))) return;
    const page = [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')]
      .filter(el => el.tabIndex >= 0 && !el.disabled && el.getAttribute('aria-hidden') !== 'true' && !popup.contains(el) && el.getClientRects().length);
    const next = page[page.indexOf(trigger) + (event.shiftKey ? -1 : 1)];
    event.preventDefault();
    close();
    (next || trigger).focus();
  });
  let focused = parse(input.value) || parse(input.max) || new Date();
  if (input.max && iso(focused) > input.max) focused = parse(input.max);
  if (input.min && iso(focused) < input.min) focused = parse(input.min);
  active = { input, trigger, popup, focused, month: new Date(focused.getFullYear(), focused.getMonth(), 1, 12) };
  trigger.setAttribute('aria-expanded', 'true');
  document.body.append(popup);
  render();
  popup.querySelector('[tabindex="0"]')?.focus();
}
function enhance(input) {
  if (fields.has(input)) return;
  fields.add(input);
  const label = [...(input.labels || [])].map(el => el.textContent.trim()).join(' ') || 'Date';
  input.type = 'text';
  input.classList.add('sp-date-input');
  input.placeholder = 'YYYY-MM-DD';
  input.autocomplete = 'off';
  input.maxLength = 10;
  input.setAttribute('aria-label', `${label} (YYYY-MM-DD)`);
  const wrapper = document.createElement('span');
  wrapper.className = 'sp-date';
  input.before(wrapper); wrapper.append(input);
  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.className = 'sp-date-trigger';
  trigger.dataset.label = label;
  trigger.setAttribute('aria-label', `Choose ${label.toLowerCase()} date`);
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', `sp-calendar-${++sequence}`);
  trigger.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="5" width="14" height="12" rx="2"/><path d="M6 3v4m8-4v4M3 10h14"/></svg>';
  trigger.addEventListener('click', () => open(input, trigger));
  input.addEventListener('input', () => { input.setCustomValidity(''); });
  input.addEventListener('change', () => valid(input));
  input.addEventListener('blur', () => valid(input));
  input.addEventListener('keydown', event => {
    if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); open(input, trigger); }
  });
  wrapper.append(trigger);
  input.form?.addEventListener('submit', event => {
    if (!valid(input)) { event.preventDefault(); event.stopImmediatePropagation(); input.reportValidity(); }
  }, true);
}
function refresh() {
  document.querySelectorAll('input[type="date"]').forEach(enhance);
  if (active && !active.input.isConnected) close();
}
document.addEventListener('pointerdown', event => {
  if (active && !active.popup.contains(event.target) && !active.trigger.parentElement.contains(event.target)) close();
});
document.addEventListener('focusin', event => {
  if (active && !active.popup.contains(event.target) && !active.trigger.parentElement.contains(event.target)) close();
});
document.addEventListener('keydown', event => {
  if (active && event.key === 'Escape') { event.preventDefault(); close(true); }
});
window.addEventListener('resize', () => close());
document.addEventListener('scroll', event => {
  if (active && !active.popup.contains(event.target)) close();
}, true);
new MutationObserver(refresh).observe(document.body, { childList: true, subtree: true });
refresh();
