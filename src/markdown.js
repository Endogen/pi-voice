'use strict';
// Only this renderer's output may be assigned to a message's innerHTML.
// Raw HTML is escaped by markdown-it; no HTML-enabled plugins are installed.
globalThis.PiVoiceMarkdown = (() => {
  const md = new globalThis.markdownit({
    html: false, linkify: true, breaks: true, typographer: false, maxNesting: 32,
  });
  const validateLink = md.validateLink.bind(md);
  md.validateLink = (url) => {
    // Keep relative/anchor links, but never launch arbitrary Android intents,
    // javascript:, data:, file:, or other non-web protocols from model output.
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
    return validateLink(url) && (!scheme || /^(https?|mailto)$/i.test(scheme[1]));
  };
  md.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noopener noreferrer');
    return renderer.renderToken(tokens, index, options);
  };
  // Do not fetch remote images (tracking pixels) or load local API URLs as images.
  md.renderer.rules.image = (tokens, index) => `<span class="image-alt">[Image: ${md.utils.escapeHtml(tokens[index].content || 'image')}]</span>`;
  md.renderer.rules.table_open = () => '<div class="table-scroll"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';
  for (const rule of ['th_open', 'td_open']) {
    md.renderer.rules[rule] = (tokens, index, options, _env, renderer) => {
      const token = tokens[index];
      const alignment = /^text-align:\s*(left|center|right);?$/.exec(token.attrGet('style') || '');
      // Our CSP forbids inline styles, so use local CSS classes for table alignment.
      token.attrs = (token.attrs || []).filter(([name]) => name !== 'style');
      if (alignment) token.attrJoin('class', `align-${alignment[1]}`);
      return renderer.renderToken(tokens, index, options);
    };
  }
  // Small token-only extension for GitHub-style task lists. The only generated
  // input is a disabled checkbox; no untrusted HTML or attributes are inserted.
  md.core.ruler.after('inline', 'voice_task_lists', (state) => {
    for (let i = 2; i < state.tokens.length; i++) {
      const token = state.tokens[i];
      if (token.type !== 'inline' || state.tokens[i - 1].type !== 'paragraph_open' || state.tokens[i - 2].type !== 'list_item_open') continue;
      const first = token.children?.[0];
      const match = first?.type === 'text' && /^\[([ xX])\][ \t]+/.exec(first.content);
      if (!match) continue;
      first.content = first.content.slice(match[0].length);
      const checkbox = new state.Token('voice_checkbox', 'input', 0);
      checkbox.meta = { checked: match[1] !== ' ' };
      token.children.unshift(checkbox);
      state.tokens[i - 2].attrJoin('class', 'task-list-item');
    }
  });
  md.renderer.rules.voice_checkbox = (tokens, index) => tokens[index].meta.checked
    ? '<input type="checkbox" checked disabled aria-label="Completed"> '
    : '<input type="checkbox" disabled aria-label="Not completed"> ';
  return Object.freeze({ render: (text) => md.render(String(text)) });
})();
