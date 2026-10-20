/* Single-select enhancement. Native controls remain the source of form values.
 * After a silent `.value = ...`, call SPSelect.refresh(select or containing root).
 * Setting data-sp-select-native opts a select out of enhancement.
 */
(() => {
  'use strict';
  if (window.SPSelect) return;
  const states = new Map();
  const ignored = new WeakSet();
  let active = null, sequence = 0, frame = 0;
  const pending = new Set();
  const nextId = prefix => {
    let id;
    do { id = `sp-select-${prefix}-${++sequence}`; } while (document.getElementById(id));
    return id;
  };
  const setAttribute = (node, name, value) => {
    if (value === null || value === undefined || value === false) {
      if (node.hasAttribute(name)) node.removeAttribute(name);
    } else if (node.getAttribute(name) !== String(value)) node.setAttribute(name, String(value));
  };
  const eligible = select => select instanceof HTMLSelectElement && select.isConnected &&
    !select.multiple && select.size <= 1 && !select.hidden && !select.hasAttribute('data-sp-select-native');
  const disabled = select => select.disabled || select.matches(':disabled');
  const optionDisabled = option => option.disabled || option.parentElement?.disabled === true;
  const optionHidden = option => option.hidden || option.parentElement?.hidden === true;
  const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const normalized = value => text(value).normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
  const listen = (state, node, type, listener, options) => {
    node.addEventListener(type, listener, options);
    state.listeners.push(() => node.removeEventListener(type, listener, options));
  };
  function labelText(node) {
    const copy = node.cloneNode(true);
    copy.querySelectorAll('select,input,button,textarea,.sp-select,[aria-hidden="true"]').forEach(child => child.remove());
    return text(copy.textContent);
  }
  function accessibleName(select) {
    const references = text(select.getAttribute('aria-labelledby')).split(' ').filter(Boolean);
    const referenced = references.map(id => document.getElementById(id)).filter(Boolean).map(labelText).filter(Boolean);
    if (referenced.length) return referenced.join(' ');
    if (select.getAttribute('aria-label')) return text(select.getAttribute('aria-label'));
    const labels = Array.from(select.labels || [], labelText).filter(Boolean);
    return labels.join(' ') || text(select.title) || text(select.name) || 'Choose an option';
  }
  function selectedOption(state) { return state.select.options[state.select.selectedIndex] || null; }
  function selectedRow(state) { return state.rows.find(row => row.option === selectedOption(state)); }
  function enabledRows(state) { return state.rows.filter(row => !optionDisabled(row.option)); }
  function initialOption(state) {
    const selected = selectedRow(state)?.option;
    return selected && !optionDisabled(selected) ? selected : enabledRows(state)[0]?.option;
  }
  function visible(state) { return state.button.isConnected && state.button.getClientRects().length > 0; }
  function scrollActive(state) {
    const row = state.rows.find(item => item.option === state.highlighted);
    if (!row) return;
    // Scroll only the list, never the page containing the trigger.
    const rect = row.node.getBoundingClientRect(), box = state.list.getBoundingClientRect();
    if (rect.top < box.top) state.list.scrollTop -= box.top - rect.top;
    else if (rect.bottom > box.bottom) state.list.scrollTop += rect.bottom - box.bottom;
  }
  function highlight(state, option, scroll = true) {
    state.highlighted = option && state.rows.some(row => row.option === option) && !optionDisabled(option) ? option : null;
    for (const row of state.rows) row.node.classList.toggle('is-active', row.option === state.highlighted);
    const row = state.rows.find(item => item.option === state.highlighted);
    setAttribute(state.button, 'aria-activedescendant', active === state && row ? row.node.id : null);
    if (scroll && active === state) scrollActive(state);
  }
  function position(state) {
    if (active !== state) return;
    if (!visible(state)) { close(); return; }
    const rect = state.button.getBoundingClientRect(), viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0;
    const width = viewport?.width || document.documentElement.clientWidth;
    const height = viewport?.height || window.innerHeight;
    const rightEdge = leftEdge + width, bottomEdge = topEdge + height, margin = 8, gap = 5;
    if (rect.bottom < topEdge || rect.top > bottomEdge || rect.right < leftEdge || rect.left > rightEdge) { close(); return; }
    const popupWidth = Math.max(0, Math.min(Math.max(rect.width, 170), width - margin * 2));
    const below = Math.max(0, bottomEdge - rect.bottom - margin - gap);
    const above = Math.max(0, rect.top - topEdge - margin - gap);
    const upward = below < 180 && above > below;
    const available = Math.min(360, upward ? above : below);
    if (available < 30) { close(); return; }
    Object.assign(state.popup.style, {
      position: 'fixed', zIndex: '10000', width: `${popupWidth}px`,
      left: `${Math.max(leftEdge + margin, Math.min(rect.left, rightEdge - popupWidth - margin))}px`,
      maxHeight: `${available}px`, top: `${rect.bottom + gap}px`,
    });
    const styles = getComputedStyle(state.popup);
    const chrome = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']
      .reduce((sum, key) => sum + (parseFloat(styles[key]) || 0), 0);
    state.list.style.maxHeight = `${Math.max(0, available - chrome)}px`;
    state.popup.style.top = `${upward ? Math.max(topEdge + margin, rect.top - gap - state.popup.getBoundingClientRect().height) : rect.bottom + gap}px`;
  }
  function buildOptions(state) {
    const options = Array.from(state.select.options);
    const signature = JSON.stringify(options.map(option => [
      option.label, option.value, option.disabled, option.hidden,
      option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement.label : null,
      option.parentElement?.disabled, option.parentElement?.hidden,
    ]));
    // Identity matters when a new option list has identical text and values.
    if (signature === state.signature && options.length === state.options.length &&
        options.every((option, index) => option === state.options[index])) return;
    state.signature = signature;
    state.options = options;
    state.rows = [];
    const fragment = document.createDocumentFragment();
    let previousGroup = null, container = fragment;
    for (const option of options) {
      if (optionHidden(option)) continue;
      const group = option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement : null;
      if (group !== previousGroup) {
        previousGroup = group;
        container = fragment;
        if (group) {
          container = document.createElement('div');
          container.className = 'sp-select-optgroup';
          container.setAttribute('role', 'group');
          container.setAttribute('aria-label', group.label);
          const heading = document.createElement('div');
          heading.className = 'sp-select-group';
          heading.setAttribute('aria-hidden', 'true');
          heading.textContent = group.label;
          container.appendChild(heading);
          fragment.appendChild(container);
        }
      }
      const node = document.createElement('div');
      node.className = 'sp-select-option';
      node.id = nextId('option');
      node.setAttribute('role', 'option');
      node.textContent = option.label || '\u00a0';
      const unavailable = optionDisabled(option);
      node.classList.toggle('is-disabled', unavailable);
      setAttribute(node, 'aria-disabled', unavailable ? 'true' : null);
      state.rows.push({ option, node });
      container.appendChild(node);
    }
    if (!state.rows.length) {
      const empty = document.createElement('div');
      empty.className = 'sp-select-empty';
      empty.textContent = 'No options available';
      fragment.appendChild(empty);
    }
    state.list.replaceChildren(fragment);
  }
  function sync(state) {
    if (!eligible(state.select)) { remove(state); return; }
    const { select, button, wrapper } = state;
    if (select.getAttribute('tabindex') !== '-1') {
      state.tabindex = select.getAttribute('tabindex');
      setAttribute(select, 'tabindex', '-1');
    }
    button.tabIndex = state.tabindex === null ? 0 : (Number(state.tabindex) || 0);
    button.disabled = disabled(select);
    wrapper.classList.toggle('is-disabled', button.disabled);
    const name = accessibleName(select);
    setAttribute(button, 'aria-label', name);
    setAttribute(state.list, 'aria-label', name);
    setAttribute(button, 'aria-describedby', select.getAttribute('aria-describedby'));
    setAttribute(button, 'aria-required', select.required ? 'true' : null);
    if (select.validity.valid) state.invalid = false;
    setAttribute(button, 'aria-invalid', select.getAttribute('aria-invalid') || (state.invalid ? 'true' : null));
    setAttribute(button, 'title', select.title || (state.invalid ? select.validationMessage : null));
    const selected = selectedOption(state);
    const label = selected ? selected.label : select.getAttribute('data-placeholder') || 'Select…';
    if (state.value.textContent !== label) state.value.textContent = label;
    state.value.classList.toggle('is-placeholder', !selected || selected.value === '');
    buildOptions(state);
    for (const row of state.rows) {
      const isSelected = row.option === selected;
      row.node.classList.toggle('is-selected', isSelected);
      setAttribute(row.node, 'aria-selected', String(isSelected));
    }
    if (active === state) {
      if (button.disabled) { close(); return; }
      const current = state.rows.find(row => row.option === state.highlighted && !optionDisabled(row.option));
      highlight(state, current?.option || initialOption(state), false);
      position(state);
    }
  }
  function focusAfterChange(state) {
    // A change handler may replace the entire dashboard. Do not steal focus
    // from another control that the handler deliberately focused.
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused !== state.button && focused !== state.select) return;
    let destination = state;
    if (!state.button.isConnected && state.select.id) {
      const replacement = document.getElementById(state.select.id);
      if (eligible(replacement)) destination = enhance(replacement);
    }
    if (destination?.button.isConnected && !destination.button.disabled) destination.button.focus({ preventScroll: true });
  }
  function close({ commit = false, focus = false } = {}) {
    const state = active;
    if (!state) return;
    const option = state.highlighted;
    active = null;
    state.popup.hidden = true;
    state.wrapper.classList.remove('is-open');
    setAttribute(state.button, 'aria-expanded', 'false');
    setAttribute(state.button, 'aria-activedescendant', null);
    state.buffer = '';
    // Close first: the following native events can synchronously rerender.
    if (commit && eligible(state.select) && !disabled(state.select) &&
        option && !optionDisabled(option) && !optionHidden(option)) {
      const index = Array.from(state.select.options).indexOf(option);
      if (index >= 0 && index !== state.select.selectedIndex) {
        state.select.selectedIndex = index;
        sync(state);
        state.select.dispatchEvent(new Event('input', { bubbles: true }));
        state.select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    if (state.select.isConnected && states.has(state.select)) sync(state);
    if (focus) focusAfterChange(state);
  }
  function open(state, focus = true) {
    if (!state || !states.has(state.select)) return;
    sync(state);
    if (!eligible(state.select) || disabled(state.select) || !visible(state)) return;
    if (active && active !== state) close();
    if (active === state) return;
    active = state;
    state.buffer = '';
    if (!state.popup.isConnected) document.body.appendChild(state.popup);
    state.popup.hidden = false;
    state.wrapper.classList.add('is-open');
    setAttribute(state.button, 'aria-expanded', 'true');
    position(state);
    if (active !== state) return;
    highlight(state, initialOption(state));
    if (focus) state.button.focus({ preventScroll: true });
  }
  function move(state, amount) {
    const rows = enabledRows(state);
    if (!rows.length) return;
    const current = rows.findIndex(row => row.option === state.highlighted);
    const index = amount === 'first' ? 0 : amount === 'last' ? rows.length - 1 :
      Math.max(0, Math.min(rows.length - 1, (current < 0 ? 0 : current) + amount));
    highlight(state, rows[index].option);
  }
  function typeahead(state, character) {
    const now = Date.now(), continuing = now - state.typedAt < 700;
    state.buffer = continuing ? state.buffer + character : character;
    state.typedAt = now;
    const characters = Array.from(state.buffer);
    const repeating = characters.length > 1 && characters.every(letter => letter === characters[0]);
    const needle = normalized(repeating ? characters[0] : state.buffer);
    const rows = enabledRows(state);
    const current = rows.findIndex(row => row.option === state.highlighted);
    const start = continuing && !repeating ? Math.max(0, current) : current + 1;
    for (let offset = 0; offset < rows.length; offset++) {
      const row = rows[(start + offset + rows.length) % rows.length];
      if (normalized(row.option.label).startsWith(needle)) { highlight(state, row.option); return; }
    }
  }
  function keydown(state, event) {
    if (event.isComposing || event.ctrlKey || event.metaKey || disabled(state.select)) return;
    const key = event.key, opened = active === state;
    if (key === 'Escape') {
      if (opened) { event.preventDefault(); close({ focus: true }); }
      return;
    }
    if (key === 'Tab') { if (opened) close({ commit: true, focus: true }); return; }
    if (event.altKey && key === 'ArrowUp') {
      if (opened) { event.preventDefault(); close({ commit: true, focus: true }); }
      return;
    }
    if (event.altKey && key !== 'ArrowDown') return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(key)) {
      event.preventDefault();
      open(state);
      if (active !== state) return;
      if (key === 'Home') move(state, 'first');
      else if (key === 'End') move(state, 'last');
      else if (opened && !event.altKey) move(state, key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : key === 'PageDown' ? 10 : -10);
      return;
    }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      if (key === ' ' && opened && state.buffer && Date.now() - state.typedAt < 700) typeahead(state, key);
      else if (opened) close({ commit: true, focus: true });
      else open(state);
      return;
    }
    if (key.length === 1 && !event.altKey) {
      event.preventDefault();
      open(state);
      if (active === state) typeahead(state, key);
    }
  }
  function remove(state, manual = false) {
    if (!states.has(state.select)) return;
    states.delete(state.select);
    if (active === state) close();
    if (manual) ignored.add(state.select);
    state.listeners.forEach(dispose => dispose());
    state.popup.remove();
    state.select.classList.remove('sp-select-native');
    setAttribute(state.select, 'aria-hidden', state.ariaHidden);
    if (state.select.getAttribute('tabindex') === '-1') setAttribute(state.select, 'tabindex', state.tabindex);
    if (state.wrapper.parentNode && state.select.parentNode === state.wrapper) state.wrapper.replaceWith(state.select);
    else state.wrapper.remove();
  }
  function enhance(select) {
    if (states.has(select)) { sync(states.get(select)); return states.get(select); }
    if (!eligible(select) || ignored.has(select) || !document.body) return null;
    const wasFocused = document.activeElement === select;
    const wrapper = document.createElement('div');
    wrapper.className = 'sp-select';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sp-select-button';
    button.id = nextId('trigger');
    button.setAttribute('role', 'combobox');
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    const value = document.createElement('span');
    value.className = 'sp-select-value';
    const chevron = document.createElement('span');
    chevron.className = 'sp-select-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    button.append(value, chevron);
    const popup = document.createElement('div');
    popup.className = 'sp-select-popup';
    popup.hidden = true;
    const list = document.createElement('div');
    list.className = 'sp-select-listbox';
    list.id = nextId('listbox');
    list.setAttribute('role', 'listbox');
    popup.appendChild(list);
    button.setAttribute('aria-controls', list.id);
    const state = { select, wrapper, button, value, popup, list, listeners: [],
      tabindex: select.getAttribute('tabindex'), ariaHidden: select.getAttribute('aria-hidden'),
      options: [], rows: [], signature: null, highlighted: null, buffer: '', typedAt: 0, invalid: false };
    states.set(select, state);
    select.before(wrapper);
    wrapper.append(select, button);
    select.classList.add('sp-select-native');
    setAttribute(select, 'aria-hidden', 'true');
    setAttribute(select, 'tabindex', '-1');
    document.body.appendChild(popup);
    listen(state, button, 'click', () => active === state ? close({ focus: true }) : open(state));
    listen(state, button, 'keydown', event => keydown(state, event));
    listen(state, button, 'focus', () => sync(state));
    listen(state, select, 'change', () => sync(state));
    listen(state, select, 'input', () => sync(state));
    listen(state, select, 'focus', () => button.focus({ preventScroll: true }));
    listen(state, select, 'click', event => { event.preventDefault(); open(state); });
    listen(state, select, 'invalid', event => {
      event.preventDefault();
      state.invalid = true;
      sync(state);
      button.focus();
    });
    listen(state, popup, 'pointerdown', event => {
      // Keep DOM focus on the combobox while clicking an option.
      if (event.target.closest('.sp-select-option')) event.preventDefault();
    });
    listen(state, popup, 'pointermove', event => {
      const node = event.target.closest('.sp-select-option');
      const row = state.rows.find(item => item.node === node);
      if (row && !optionDisabled(row.option)) highlight(state, row.option, false);
    });
    listen(state, popup, 'click', event => {
      const node = event.target.closest('.sp-select-option');
      const row = state.rows.find(item => item.node === node);
      if (!row || optionDisabled(row.option)) return;
      highlight(state, row.option, false);
      close({ commit: true, focus: true });
    });
    sync(state);
    if (wasFocused && !button.disabled) button.focus({ preventScroll: true });
    return state;
  }
  function selectsWithin(target) {
    if (!target) return [];
    return [...(target instanceof HTMLSelectElement ? [target] : []), ...Array.from(target.querySelectorAll?.('select') || [])];
  }
  function refresh(target = document) {
    for (const state of states.values()) if (!state.select.isConnected) remove(state);
    for (const select of selectsWithin(target)) {
      ignored.delete(select);
      enhance(select);
    }
  }
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const state of states.values()) if (!state.select.isConnected || !state.wrapper.isConnected) remove(state);
      const queued = Array.from(pending);
      pending.clear();
      for (const select of queued) enhance(select);
      if (active) position(active);
    });
  }
  function generated(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !!element?.closest?.('.sp-select-button,.sp-select-popup');
  }
  function queue(target) {
    for (const select of selectsWithin(target)) pending.add(select);
  }
  function start() {
    refresh();
    const observer = new MutationObserver(records => {
      let changed = false;
      for (const record of records) {
        if (generated(record.target)) continue;
        const element = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        const owner = element?.closest?.('select');
        if (owner) { pending.add(owner); changed = true; continue; }
        if (record.type === 'childList') {
          for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE && !generated(node)) { queue(node); changed = true; }
          if (record.removedNodes.length) changed = true;
        } else if (record.type === 'attributes') { queue(element); changed = true; }
        // Label text/ARIA references can change without touching a select.
        if (element?.closest?.('label') || record.type === 'characterData') {
          for (const select of states.keys()) pending.add(select);
          changed = true;
        }
      }
      if (changed) schedule();
    });
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['disabled', 'multiple', 'size', 'hidden', 'required', 'label', 'value', 'selected',
        'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-invalid', 'title', 'tabindex', 'id',
        'data-sp-select-native', 'data-placeholder'],
    });
    document.addEventListener('pointerdown', event => {
      if (active && !active.wrapper.contains(event.target) && !active.popup.contains(event.target)) close();
    }, true);
    document.addEventListener('focusin', event => {
      if (active && !active.wrapper.contains(event.target) && !active.popup.contains(event.target)) close();
    });
    document.addEventListener('reset', event => {
      const form = event.target;
      setTimeout(() => { if (!event.defaultPrevented) refresh(form); }, 0);
    }, true);
    window.addEventListener('scroll', event => {
      if (active && event.target !== active.list && !active.popup.contains(event.target)) close();
    }, true);
    window.addEventListener('resize', () => { if (active) position(active); });
    window.visualViewport?.addEventListener('resize', () => { if (active) position(active); });
    window.visualViewport?.addEventListener('scroll', () => { if (active) position(active); });
  }
  window.SPSelect = Object.freeze({
    refresh,
    open(select) { const state = enhance(select); if (state) open(state); },
    close,
    destroy(target = document) {
      for (const select of selectsWithin(target)) { const state = states.get(select); if (state) remove(state, true); }
    },
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
