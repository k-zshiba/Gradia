(() => {
  const bindings = [];
  const segments = [];
  const skipped = 'script,style,noscript,pre,code,kbd,samp,math,svg,canvas,iframe,frame,input,textarea,select,button,option,[contenteditable], [hidden], [aria-hidden="true"],.katex,.MathJax';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const sentence = new Intl.Segmenter('en', { granularity: 'sentence' });
  let visited = 0;
  let characters = 0;
  let omitted = false;
  let node;
  while ((node = walker.nextNode()) && visited++ < 30000 && segments.length < 2000 && characters < 200000) {
    const parent = node.parentElement;
    if (!parent || parent.closest(skipped) || !node.data.trim()) continue;
    if (node.data.length > 14000) { omitted = true; continue; }
    if (!parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const original = node.data;
    const parts = [];
    for (const item of sentence.segment(original)) {
      const text = item.segment.trim();
      if (!text) continue;
      if (segments.length >= 2000 || characters + text.length > 200000) { omitted = true; break; }
      const id = `w${segments.length}`;
      const start = item.index + item.segment.indexOf(text);
      const kind = parent.closest('h1,h2,h3,h4,h5,h6') ? 'heading' : parent.closest('li') ? 'list' : 'paragraph';
      const eligible = /\b[A-Za-z]{2,}\b/.test(text.replace(/https?:\/\/\S+/g, '')) && !/[\u3040-\u30ff\u3400-\u9fff]/.test(text);
      segments.push({ id, block: bindings.length, order: segments.length, text, kind, eligible, location: { anchor: `web-v1-${id}` } });
      parts.push({ id, start, end: start + text.length });
      characters += text.length;
    }
    if (parts.length) bindings.push({ node, original, last: original, parts });
  }
  return { bindings, segments, title: document.title.slice(0, 500), url: location.href, truncated: omitted || visited >= 30000 || segments.length >= 2000 || characters >= 200000 };
})()
