/* App-styled confirmations. window.confirm would show Android's native dialog. */
(() => {
  'use strict';
  function create({ element: $, createElement }) {
    let pending;
    const dialog = $('confirm-dialog');
    function finish(answer) {
      const current = pending;
      pending = undefined;
      if (dialog.open) dialog.close();
      current?.(answer);
    }
    // Resolves true only for the confirm button. Cancel, Escape, Android back and
    // tapping outside all decline; a newer question declines the older one.
    function ask({ title, message, confirm = 'Continue', cancel = 'Cancel', danger = false }) {
      finish(false);
      $('confirm-title').textContent = title;
      $('confirm-message').replaceChildren(...[].concat(message).filter(Boolean).map((text) => {
        const paragraph = createElement('p');
        paragraph.textContent = text;
        return paragraph;
      }));
      $('confirm-accept').textContent = confirm;
      $('confirm-accept').classList.toggle('danger', danger);
      $('confirm-cancel').textContent = cancel;
      const answer = new Promise((resolve) => { pending = resolve; });
      dialog.showModal();
      return answer;
    }
    $('confirm-accept').addEventListener('click', () => finish(true));
    $('confirm-cancel').addEventListener('click', () => finish(false));
    // The close event is queued: ignore it if a newer question reopened the dialog.
    dialog.addEventListener('close', () => { if (!dialog.open) finish(false); });
    dialog.addEventListener('click', (event) => { if (event.target === dialog) finish(false); });
    return { ask };
  }
  globalThis.PiVoiceDialogs = Object.freeze({ create });
})();
