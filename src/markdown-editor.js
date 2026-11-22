export const markdownToolbar = `
<div class="editor-toolbar" role="toolbar" aria-label="\u683C\u5F0F\u5DE5\u5177\u680F">
  <button type="button" class="tb-btn" aria-label="\u52A0\u7C97" data-tooltip="\u52A0\u7C97" data-tb="bold"><b>B</b></button>
  <button type="button" class="tb-btn" aria-label="\u659C\u4F53" data-tooltip="\u659C\u4F53" data-tb="italic"><i>I</i></button>
  <button type="button" class="tb-btn" aria-label="\u5220\u9664\u7EBF" data-tooltip="\u5220\u9664\u7EBF" data-tb="strike"><s>S</s></button>
  <button type="button" class="tb-btn" aria-label="\u884C\u5185\u4EE3\u7801" data-tooltip="\u884C\u5185\u4EE3\u7801" data-tb="inline-code">
    <svg viewBox="0 0 20 20" width="16" height="16"><polyline points="7,5 3,10 7,15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><polyline points="13,5 17,10 13,15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>
  <span class="tb-sep"></span>
  <button type="button" class="tb-btn" aria-label="\u6570\u5B66\u516C\u5F0F" data-tooltip="\u6570\u5B66\u516C\u5F0F" data-tb="math">
    <svg viewBox="0 0 20 20" width="16" height="16"><polyline points="2,11 5,14 8,4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="8" y1="4" x2="18" y2="4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
  </button>
  <button type="button" class="tb-btn" aria-label="\u4EE3\u7801\u5757" data-tooltip="\u4EE3\u7801\u5757" data-tb="code-block">
    <svg viewBox="0 0 20 20" width="16" height="16"><rect x="2" y="3" width="16" height="14" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><polyline points="5,8 8,10 5,12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><line x1="10" y1="12" x2="14" y2="12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
  </button>
  <span class="tb-sep"></span>
  <button type="button" class="tb-btn" aria-label="\u94FE\u63A5" data-tooltip="\u94FE\u63A5" data-tb="link">
    <svg viewBox="0 0 20 20" width="16" height="16"><path d="M8 12a3 3 0 0 1 0-4l2-2a3 3 0 0 1 4 4l-1 1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 8a3 3 0 0 1 0 4l-2 2a3 3 0 0 1-4-4l1-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
  </button>
  <button type="button" class="tb-btn" aria-label="\u56FE\u7247" data-tooltip="\u56FE\u7247" data-tb="image">
    <svg viewBox="0 0 20 20" width="16" height="16"><rect x="2" y="3" width="16" height="14" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="8" r="1.5" fill="currentColor"/><polyline points="3,15 8,10 12,13 17,7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>
  <button type="button" class="tb-btn" aria-label="\u8868\u683C" data-tooltip="\u8868\u683C" data-tb="table">
    <svg viewBox="0 0 20 20" width="16" height="16"><rect x="2" y="3" width="16" height="14" fill="none" stroke="currentColor" stroke-width="2"/><line x1="2" y1="8" x2="18" y2="8" stroke="currentColor" stroke-width="1.6"/><line x1="2" y1="13" x2="18" y2="13" stroke="currentColor" stroke-width="1.6"/><line x1="9" y1="3" x2="9" y2="17" stroke="currentColor" stroke-width="1.6"/></svg>
  </button>
  <span class="tb-sep"></span>
  <button type="button" class="tb-btn" aria-label="\u65E0\u5E8F\u5217\u8868" data-tooltip="\u65E0\u5E8F\u5217\u8868" data-tb="ul">
    <svg viewBox="0 0 20 20" width="16" height="16"><circle cx="3.5" cy="5" r="1.5" fill="currentColor"/><line x1="8" y1="5" x2="17" y2="5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="3.5" cy="10" r="1.5" fill="currentColor"/><line x1="8" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="3.5" cy="15" r="1.5" fill="currentColor"/><line x1="8" y1="15" x2="17" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
  </button>
  <button type="button" class="tb-btn" aria-label="\u6709\u5E8F\u5217\u8868" data-tooltip="\u6709\u5E8F\u5217\u8868" data-tb="ol">
    <svg viewBox="0 0 20 20" width="16" height="16"><text x="0" y="7" font-size="6" fill="currentColor" font-family="monospace">1</text><line x1="8" y1="5" x2="17" y2="5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><text x="0" y="12" font-size="6" fill="currentColor" font-family="monospace">2</text><line x1="8" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><text x="0" y="17" font-size="6" fill="currentColor" font-family="monospace">3</text><line x1="8" y1="15" x2="17" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
  </button>
  <button type="button" class="tb-btn" aria-label="\u4EFB\u52A1\u5217\u8868" data-tooltip="\u4EFB\u52A1\u5217\u8868" data-tb="task">
    <svg viewBox="0 0 20 20" width="16" height="16"><rect x="2" y="2" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><polyline points="3.5,6 5,7.5 8.5,3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><line x1="13" y1="4" x2="18" y2="4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="2" y="12" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><line x1="13" y1="15" x2="18" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
  </button>
  <button type="button" class="tb-btn" aria-label="\u5F15\u7528" data-tooltip="\u5F15\u7528" data-tb="quote">
    <svg viewBox="0 0 20 20" width="16" height="16"><line x1="4" y1="3" x2="4" y2="17" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><line x1="9" y1="6" x2="17" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="9" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="9" y1="14" x2="14" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
  </button>
</div>
`;

export const markdownDialogs = `
<div id="code-modal" role="dialog" aria-modal="true" aria-label="\u63D2\u5165\u4EE3\u7801\u5757" class="delete-panel" hidden>
  <div class="delete-panel-inner code-modal-inner">
    <p class="delete-warning">\u63D2\u5165\u4EE3\u7801\u5757</p>
    <select id="code-lang" class="code-lang-select">
      <option value="cpp">C++</option>
      <option value="c">C</option>
      <option value="python">Python</option>
      <option value="java">Java</option>
      <option value="javascript">JavaScript</option>
      <option value="typescript">TypeScript</option>
      <option value="csharp">C#</option>
      <option value="go">Go</option>
      <option value="rust">Rust</option>
      <option value="html">HTML</option>
      <option value="css">CSS</option>
      <option value="sql">SQL</option>
      <option value="bash">Bash</option>
      <option value="plaintext">\u7EAF\u6587\u672C</option>
    </select>
    <textarea id="code-input" class="code-modal-textarea" rows="8" placeholder="\u7C98\u8D34\u4EE3\u7801\u2026\u2026"></textarea>
    <div class="delete-panel-actions">
      <button type="button" class="btn btn-ghost" onclick="closeCodeModal()">\u53D6\u6D88</button>
      <button type="button" class="btn btn-save" onclick="confirmCodeInsert()">\u786E\u5B9A</button>
    </div>
  </div>
</div>

<div id="link-modal" role="dialog" aria-modal="true" aria-labelledby="link-modal-title" class="delete-panel" hidden>
  <div class="delete-panel-inner code-modal-inner">
    <p class="delete-warning" id="link-modal-title">\u63D2\u5165\u94FE\u63A5</p>
    <input type="text" id="link-name" class="code-lang-select" aria-label="\u94FE\u63A5\u540D\u79F0" placeholder="\u94FE\u63A5\u540D\u79F0" />
    <input type="text" id="link-url" class="code-lang-select" aria-label="\u7F51\u5740" placeholder="https://" />
    <div class="delete-panel-actions">
      <button type="button" class="btn btn-ghost" onclick="closeLinkModal()">\u53D6\u6D88</button>
      <button type="button" class="btn btn-save" onclick="confirmLinkInsert()">\u786E\u5B9A</button>
    </div>
  </div>
</div>
`;

export const markdownToolbarScript = `(() => {
  const textarea = document.getElementById('content-input');
  if (!textarea) return;

  // \u2500\u2500 toolbar: insert/wrap markdown at the cursor \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // Uses document.execCommand('insertText', ...) rather than setting
  // textarea.value directly \u2014 direct .value assignment wipes the
  // browser's native undo history, so Ctrl+Z would stop working after
  // any toolbar click. execCommand keeps it intact. Falls back to
  // direct assignment only if execCommand is unavailable.
  function refresh() {
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function insertAtSelection(text) {
    textarea.focus();
    var ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    if (!ok) {
      var start = textarea.selectionStart, end = textarea.selectionEnd;
      var value = textarea.value;
      textarea.value = value.slice(0, start) + text + value.slice(end);
      textarea.setSelectionRange(start + text.length, start + text.length);
    }
    refresh();
  }

  function wrapSelection(before, after, placeholder) {
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    var selected = textarea.value.slice(start, end) || placeholder || '';
    insertAtSelection(before + selected + after);
    var selStart = start + before.length;
    var selEnd = selStart + selected.length;
    textarea.setSelectionRange(selStart, selEnd);
  }

  function insertBlock(text) {
    var start = textarea.selectionStart;
    var value = textarea.value;
    var needsLeadingNewline = start > 0 && value[start - 1] !== '\\n';
    insertAtSelection((needsLeadingNewline ? '\\n' : '') + text);
  }

  function prefixLines(prefixFn) {
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    var value = textarea.value;
    var lineStart = value.lastIndexOf('\\n', start - 1) + 1;
    var lineEnd = value.indexOf('\\n', end);
    if (lineEnd === -1) lineEnd = value.length;
    var block = value.slice(lineStart, lineEnd);
    var newBlock = block.split('\\n').map(prefixFn).join('\\n');
    textarea.setSelectionRange(lineStart, lineEnd);
    insertAtSelection(newBlock);
    textarea.setSelectionRange(lineStart, lineStart + newBlock.length);
  }

  var TOOLBAR_ACTIONS = {
    'bold': function () { wrapSelection('**', '**', '\u52A0\u7C97\u6587\u5B57'); },
    'italic': function () { wrapSelection('*', '*', '\u659C\u4F53\u6587\u5B57'); },
    'strike': function () { wrapSelection('~~', '~~', '\u5220\u9664\u7EBF\u6587\u5B57'); },
    'inline-code': function () { wrapSelection('\`', '\`', 'code'); },
    'math': function () { wrapSelection('$$', '$$', ''); },
    'code-block': function () { openCodeModal(); },
    'link': function () { openLinkModal(false); },
    'image': function () { openLinkModal(true); },
    'table': function () { insertBlock('| \u52171 | \u52172 |\\n|:---|:---:|\\n| \u5185\u5BB9 | \u5185\u5BB9 |\\n'); },
    'ul': function () { prefixLines(function (l) { return '- ' + l; }); },
    'ol': function () { prefixLines(function (l, i) { return (i + 1) + '. ' + l; }); },
    'task': function () { prefixLines(function (l) { return '- [ ] ' + l; }); },
    'quote': function () { prefixLines(function (l) { return '> ' + l; }); },
  };

  document.querySelectorAll('.tb-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var action = TOOLBAR_ACTIONS[btn.dataset.tb];
      if (action) action();
    });
  });

  // \u2500\u2500 code-block modal \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function openCodeModal() {
    document.getElementById('code-input').value = '';
    document.getElementById('code-modal').hidden = false;
    document.getElementById('code-input').focus();
  }
  function closeCodeModal() {
    document.getElementById('code-modal').hidden = true;
    textarea.focus();
  }
  function confirmCodeInsert() {
    var lang = document.getElementById('code-lang').value;
    var code = document.getElementById('code-input').value;
    var runs = code.match(/\\x60+/g) || [];
    var size = runs.reduce(function (length, run) { return Math.max(length, run.length + 1); }, 3);
    var fence = String.fromCharCode(96).repeat(size);
    insertBlock(fence + lang + '\\n' + code + (code.endsWith('\\n') ? '' : '\\n') + fence + '\\n');
    closeCodeModal();
  }
  window.openCodeModal = openCodeModal;
  window.closeCodeModal = closeCodeModal;
  window.confirmCodeInsert = confirmCodeInsert;

  // \u2500\u2500 link / image modal \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  var linkModalIsImage = false;
  function openLinkModal(isImage) {
    linkModalIsImage = isImage;
    document.getElementById('link-modal-title').textContent = isImage ? '\u63D2\u5165\u56FE\u7247' : '\u63D2\u5165\u94FE\u63A5';
    document.getElementById('link-name').placeholder = isImage ? '\u56FE\u7247\u63CF\u8FF0' : '\u94FE\u63A5\u540D\u79F0';
    document.getElementById('link-url').placeholder = isImage ? 'https://\uFF0C\u6216\u76F4\u63A5\u7C98\u8D34\u526A\u8D34\u677F\u56FE\u7247\uFF08Ctrl+V\uFF09' : 'https://';
    document.getElementById('link-name').value = '';
    document.getElementById('link-url').value = '';
    document.getElementById('link-modal').hidden = false;
    document.getElementById('link-name').focus();
  }
  function closeLinkModal() {
    document.getElementById('link-modal').hidden = true;
    textarea.focus();
  }
  function confirmLinkInsert() {
    var name = document.getElementById('link-name').value || (linkModalIsImage ? '\u56FE\u7247\u63CF\u8FF0' : '\u94FE\u63A5\u6587\u5B57');
    var url = document.getElementById('link-url').value || 'https://';
    var prefix = linkModalIsImage ? '![' : '[';
    insertAtSelection(prefix + name + '](' + url + ')');
    closeLinkModal();
  }
  window.openLinkModal = openLinkModal;
  window.closeLinkModal = closeLinkModal;
  window.confirmLinkInsert = confirmLinkInsert;

  // Keep diagrams and code screenshots lossless when they fit.
  function compressImageFile(file, callback) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var img = new Image();
      img.onload = function () {
        var maxDim = 2000;
        var w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
          else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const png = canvas.toDataURL('image/png');
        callback(png.length <= 700000 ? png : canvas.toDataURL('image/webp', 0.92));
      };
      img.onerror = function () { callback(e.target.result); }; // fallback: use the raw file
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // paste an image from the clipboard straight into the URL field \u2014
  // compresses it and converts it to a data URI so no separate image
  // host is needed
  var linkUrlInput = document.getElementById('link-url');
  if (linkUrlInput) {
    linkUrlInput.addEventListener('paste', function (e) {
      var cd = e.clipboardData || window.clipboardData;
      if (!cd || !cd.items) return;
      for (var i = 0; i < cd.items.length; i++) {
        if (cd.items[i].type && cd.items[i].type.indexOf('image') !== -1) {
          var blob = cd.items[i].getAsFile();
          if (!blob) continue;
          e.preventDefault();
          linkUrlInput.value = '\u538B\u7F29\u4E2D\u2026';
          compressImageFile(blob, function (dataUrl) {
            linkUrlInput.value = dataUrl;
          });
          break;
        }
      }
    });
  }
})();`;
