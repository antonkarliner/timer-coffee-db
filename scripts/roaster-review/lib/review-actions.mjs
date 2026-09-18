// Reviewer input is the write contract. Recommendations never authorize writes.
export const REVIEW_ACTIONS = [
  'approve create', 'approve update', 'approve alias', 'complete existing',
  'hold 30 days', 're-enrich', 'reject',
];
export const REVIEW_REASONS = [
  'wrong_entity', 'ambiguous_identity', 'logo_missing', 'location_mismatch',
  'contaminated_data', 'stale_data', 'other',
];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);
export function normalizeReviewAction(card) {
  const comment = String(card.comment ?? '').trim().toLowerCase();
  if (!comment) return { execution_action: 'skip', cluster_id: card.cluster_id };
  const action = comment === 'hold' ? 'hold 30 days' : comment;
  if (!REVIEW_ACTIONS.includes(action)) {
    throw new Error(`Card ${card.card}: ambiguous action; use an explicit review action`);
  }
  const result = {
    execution_action: action === 'hold 30 days' ? 'hold' : action,
    cluster_id: card.cluster_id,
    logo_override: String(card.logo_override ?? '').trim(),
  };
  if (action === 'hold 30 days' || action === 're-enrich') {
    const prefix = action === 'hold 30 days' ? 'hold' : 're_enrich';
    const reason = card[`${prefix}_reason`];
    const notes = String(card[`${prefix}_notes`] ?? '').trim();
    if (!REVIEW_REASONS.includes(reason) || !notes || notes.length > 400) {
      throw new Error(`Card ${card.card}: ${prefix} requires a valid reason and 1-400 character notes`);
    }
    result[`${prefix}_reason`] = reason;
    result[`${prefix}_notes`] = notes;
  }
  return result;
}
// Append each card's controls to its evidence card, then the handoff block once.
// No custom dates: the database sets the actual hold expiry when it accepts it.
export function renderReviewControls(cards, batchId) {
  const seen = new Set();
  for (const c of cards) {
    if (!Number.isInteger(c.card) || seen.has(c.card)) throw new Error('Invalid/duplicate card id');
    seen.add(c.card);
  }
  const controls = new Map(cards.map((c) => [c.card, `
    <div data-review-card="${c.card}">
      <div>${REVIEW_ACTIONS.map((a) => `<button type="button" data-review-action="${a}" data-review-number="${c.card}">${a}</button>`).join('')}</div>
      <label>Reviewer comment <textarea data-review-comment="${c.card}"></textarea></label>
      <label>Logo override <input type="url" data-review-logo="${c.card}"></label>
      <label>Hold reason <select data-review-hold-reason="${c.card}">${REVIEW_REASONS.map((r) => `<option value="${r}">${r.replaceAll('_', ' ')}</option>`).join('')}</select></label>
      <label>Notes for the next check <textarea maxlength="400" data-review-hold-notes="${c.card}">${esc(c.hold_notes ?? '')}</textarea></label>
      <p>Hold pauses enrichment for 30 days, then requests one fresh check. The confirmed expiry is returned after execution.</p>
    </div>`]));
  const initial = Object.fromEntries(cards.map((c) => [String(c.card), {
    card: c.card, cluster_id: c.cluster_id, title: c.title,
    recommendation: c.recommendation, comment: '', logo_override: '',
    hold_reason: c.hold_reason ?? c.re_enrich_reason ?? 'other',
    hold_notes: c.hold_notes ?? c.re_enrich_notes ?? '',
    re_enrich_reason: c.re_enrich_reason ?? '', re_enrich_notes: c.re_enrich_notes ?? '',
  }]));
  const jsValue = (x) => JSON.stringify(x).replace(/</g, '\\u003c');
  const handoff = `
    <label>Comments JSON <textarea id="review-json" readonly rows="24"></textarea></label>
    <button type="button" id="copy-review-json">Copy comments JSON</button>
    <button type="button" id="download-review-json">Download comments JSON</button>
    <button type="button" id="clear-review-inputs">Clear saved review inputs</button>
    <span id="review-status" role="status"></span>
    <script>
    const startReviewWiring = () => {
    (() => {
      const review = ${jsValue(initial)};
      const storageKey = ${jsValue(`roaster-review:${batchId}`)};
      const status = (s) => { document.getElementById('review-status').textContent = s; };
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { status('Saved inputs unavailable. Use the visible JSON.'); }
      const render = () => { document.getElementById('review-json').value = JSON.stringify(review, null, 2); };
      const save = () => {
        render();
        try { localStorage.setItem(storageKey, JSON.stringify(review)); } catch { status('Storage unavailable. Copy the visible JSON before closing.'); }
      };
      for (const [n, card] of Object.entries(review)) {
        const comment = document.querySelector('[data-review-comment="'+n+'"]');
        const logo = document.querySelector('[data-review-logo="'+n+'"]');
        const holdReason = document.querySelector('[data-review-hold-reason="'+n+'"]');
        const holdNotes = document.querySelector('[data-review-hold-notes="'+n+'"]');
        card.comment = typeof saved?.[n]?.comment === 'string' ? saved[n].comment : '';
        card.logo_override = typeof saved?.[n]?.logo_override === 'string' ? saved[n].logo_override : '';
        comment.value = card.comment; logo.value = card.logo_override;
        card.hold_reason = typeof saved?.[n]?.hold_reason === 'string' ? saved[n].hold_reason : card.hold_reason;
        card.hold_notes = typeof saved?.[n]?.hold_notes === 'string' ? saved[n].hold_notes : card.hold_notes;
        holdReason.value = card.hold_reason; holdNotes.value = card.hold_notes;
        comment.addEventListener('input', () => { card.comment = comment.value; save(); });
        logo.addEventListener('input', () => { card.logo_override = logo.value; save(); });
        holdReason.addEventListener('change', () => { card.hold_reason = holdReason.value; save(); });
        holdNotes.addEventListener('input', () => { card.hold_notes = holdNotes.value; save(); });
      }
      document.querySelectorAll('[data-review-action]').forEach((b) => b.addEventListener('click', () => {
        const n = b.dataset.reviewNumber;
        document.querySelector('[data-review-comment="'+n+'"]').value = b.dataset.reviewAction;
        review[n].comment = b.dataset.reviewAction; save();
      }));
      document.getElementById('copy-review-json').onclick = async () => {
        try { await navigator.clipboard.writeText(document.getElementById('review-json').value); status('Copied.'); }
        catch { status('Copy unavailable. Select and copy the visible JSON.'); }
      };
      document.getElementById('download-review-json').onclick = () => {
        const url = URL.createObjectURL(new Blob([document.getElementById('review-json').value], {type:'application/json'}));
        const a = document.createElement('a'); a.href = url; a.download = 'comments.json'; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000); status('Download requested.');
      };
      document.getElementById('clear-review-inputs').onclick = () => {
        if (!confirm('Clear saved review inputs?')) return;
        for (const [n, c] of Object.entries(review)) {
          c.comment = ''; c.logo_override = '';
          c.hold_reason = ${jsValue(initial)}[n].hold_reason;
          c.hold_notes = ${jsValue(initial)}[n].hold_notes;
          document.querySelector('[data-review-comment="'+n+'"]').value = '';
          document.querySelector('[data-review-logo="'+n+'"]').value = '';
          document.querySelector('[data-review-hold-reason="'+n+'"]').value = c.hold_reason;
          document.querySelector('[data-review-hold-notes="'+n+'"]').value = c.hold_notes;
        }
        save(); status('Review inputs cleared.');
      };
      render();
    })();
    };
    // The handoff block may be rendered before the cards (or anywhere) — defer
    // wiring until the DOM is parsed so querySelector calls cannot miss.
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startReviewWiring);
    else startReviewWiring();
    </script>`;
  return { controls, handoff };
}
