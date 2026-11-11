function (updates, bilingual) {
  const texts = new Map(updates.map(item => [item.id, item.text]));
  let written = 0;
  let skipped = 0;
  for (const binding of this.bindings) {
    if (!binding.node.isConnected || binding.node.data !== binding.last) { skipped++; continue; }
    let value = '';
    let offset = 0;
    for (const part of binding.parts) {
      value += binding.original.slice(offset, part.start);
      const original = binding.original.slice(part.start, part.end);
      const translated = texts.get(part.id);
      value += translated === undefined ? original : bilingual ? `${original}\n（${translated}）` : translated;
      offset = part.end;
    }
    value += binding.original.slice(offset);
    binding.node.data = value;
    binding.last = value;
    written++;
  }
  return { written, skipped };
}
