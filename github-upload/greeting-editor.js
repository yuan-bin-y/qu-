(function (scope) {
  'use strict';
  function read(node) {
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.dataset?.greetingToken === 'city') return '{city}';
    if (node.nodeName === 'BR') return '\n';
    let value = '';
    for (const child of node.childNodes || []) {
      if (/^(DIV|P)$/.test(child.nodeName) && value && !value.endsWith('\n')) value += '\n';
      value += read(child);
    }
    return value;
  }
  function create({ editor, input, bindButton, hint }) {
    let savedRange = null, lastValue = '', lastOriginals = [], composing = false;
    const doc = editor.ownerDocument;
    const tokens = () => [...editor.querySelectorAll('[data-greeting-token="city"]')];
    const originals = () => tokens().map(token => token.dataset.original || '');
    function caretAfter(node) {
      const range = doc.createRange(); range.setStartAfter(node); range.collapse(true);
      const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(range); editor.focus();
    }
    function token(original = '') {
      const chip = doc.createElement('span'); chip.className = 'greeting-city-token'; chip.contentEditable = 'false';
      chip.dataset.greetingToken = 'city'; chip.dataset.original = original;
      const label = doc.createElement('span'); label.textContent = '岗位城市';
      const remove = doc.createElement('button'); remove.type = 'button'; remove.textContent = '×';
      remove.setAttribute('aria-label', original ? '取消城市绑定，恢复“' + original + '”' : '删除城市绑定');
      remove.title = original ? '取消绑定，恢复“' + original + '”' : '删除绑定';
      remove.onclick = () => {
        if (read(editor).length - 6 + original.length > 300) { hint.textContent = '恢复原文字后超过 300 字，请先缩短文案。'; return; }
        const text = doc.createTextNode(original); chip.replaceWith(text); caretAfter(text); commit();
      };
      chip.append(label, remove); return chip;
    }
    function set(value, oldTexts = []) {
      editor.replaceChildren(); let offset = 0, index = 0;
      for (const match of value.matchAll(/\{city\}/g)) {
        editor.append(doc.createTextNode(value.slice(offset, match.index)), token(oldTexts[index++] || ''));
        offset = match.index + match[0].length;
      }
      editor.append(doc.createTextNode(value.slice(offset)));
      input.value = value; lastValue = value; lastOriginals = originals(); savedRange = null;
      bindButton.disabled = true; bindButton.textContent = '先框选要替换的文字';
      hint.textContent = '框选文字后点击上方按钮；点城市标签上的 × 恢复原文字。';
    }
    function commit() {
      if (composing) return;
      const value = read(editor);
      if (value.length > 300) {
        set(lastValue, lastOriginals); caretAfter(editor.lastChild);
        hint.textContent = '最多 300 字，刚才超出的输入未保留。'; return;
      }
      lastValue = value; lastOriginals = originals(); input.value = value;
      hint.textContent = '框选文字后点击上方按钮；点城市标签上的 × 恢复原文字。';
      input.dispatchEvent(new Event('input', { bubbles: true })); remember();
    }
    function remember() {
      const selection = doc.getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (range && editor.contains(range.startContainer) && editor.contains(range.endContainer)) savedRange = range.cloneRange();
      const insideToken = node => (node.nodeType === 1 ? node : node.parentElement)?.closest('[data-greeting-token]');
      const valid = savedRange && editor.contains(savedRange.startContainer) && editor.contains(savedRange.endContainer) && !insideToken(savedRange.startContainer) && !insideToken(savedRange.endContainer) && !savedRange.collapsed && savedRange.toString().trim() && !savedRange.cloneContents().querySelector('[data-greeting-token]');
      bindButton.disabled = editor.contentEditable !== 'true' || !valid;
      const chosen = valid ? savedRange.toString().trim() : '';
      bindButton.textContent = valid ? '将“' + (chosen.length > 10 ? chosen.slice(0, 10) + '…' : chosen) + '”设为岗位城市' : '先框选要替换的文字';
    }
    function findText(word) {
      if (!word) return null;
      const walker = doc.createTreeWalker(editor, 4);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest('[data-greeting-token]')) continue;
        const offset = node.nodeValue.indexOf(word); if (offset < 0) continue;
        const range = doc.createRange(); range.setStart(node, offset); range.setEnd(node, offset + word.length); return range;
      }
      return null;
    }
    function insertPlain(value) {
      const selection = doc.getSelection();
      if (!selection?.rangeCount || !editor.contains(selection.getRangeAt(0).commonAncestorContainer)) return;
      const range = selection.getRangeAt(0), chosen = read(range.cloneContents());
      if (read(editor).length - chosen.length + value.length > 300) { hint.textContent = '这段文字超过剩余字数，请缩短后再粘贴。'; return; }
      if (!doc.execCommand('insertText', false, value)) {
        range.deleteContents(); const text = doc.createTextNode(value); range.insertNode(text); caretAfter(text);
      }
      commit();
    }
    bindButton.addEventListener('mousedown', event => event.preventDefault());
    bindButton.onclick = () => {
      remember(); if (bindButton.disabled) return;
      const original = read(savedRange.cloneContents());
      if (read(editor).length - original.length + 6 > 300) { hint.textContent = '绑定后超过 300 字，请先缩短文案。'; return; }
      const chip = token(original); savedRange.deleteContents(); savedRange.insertNode(chip); savedRange = null;
      caretAfter(chip); commit();
    };
    editor.addEventListener('input', commit);
    editor.addEventListener('compositionstart', () => { composing = true; });
    editor.addEventListener('compositionend', () => { composing = false; commit(); });
    doc.addEventListener('selectionchange', remember);
    editor.addEventListener('paste', event => { event.preventDefault(); insertPlain(event.clipboardData.getData('text/plain')); });
    editor.addEventListener('drop', event => { event.preventDefault(); insertPlain(event.dataTransfer.getData('text/plain')); });
    for (const type of ['copy', 'cut']) editor.addEventListener(type, event => {
      const selection = doc.getSelection(); if (!selection?.rangeCount || selection.isCollapsed) return;
      const range = selection.getRangeAt(0); if (!editor.contains(range.commonAncestorContainer)) return;
      event.preventDefault(); event.clipboardData.setData('text/plain', read(range.cloneContents()));
      if (type === 'cut') { range.deleteContents(); commit(); }
    });
    return { set, originals, read: () => read(editor), hasText: word => Boolean(findText(word)),
      bindText(word) {
        const range = findText(word); if (!range || editor.contentEditable !== 'true') return false;
        const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(range); savedRange = range.cloneRange();
        bindButton.onclick(); return true;
      },
      sync() { if (input.value !== lastValue) set(input.value, originals()); },
      enable(enabled) { editor.contentEditable = String(enabled); editor.setAttribute('aria-required', String(enabled)); remember(); }
    };
  }
  scope.GreetingEditor = { read, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = scope.GreetingEditor;
})(globalThis);
