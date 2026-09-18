import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReviewAction, renderReviewControls } from './review-actions.mjs';
const card = { card: 1, cluster_id: 'cluster', recommendation: 'approve create', hold_reason: 'ambiguous_identity', hold_notes: 'No coherent official identity after bean-name research.' };
test('blank reviewer input never authorizes a generated decision', () => {
  assert.equal(normalizeReviewAction(card).execution_action, 'skip');
});
test('explicit hold overrides create and carries context', () => {
  const result = normalizeReviewAction({ ...card, comment: 'Hold 30 days' });
  assert.equal(result.execution_action, 'hold');
  assert.equal(result.hold_reason, card.hold_reason);
  assert.equal(result.hold_notes, card.hold_notes);
});
test('legacy ambiguous recommendation cannot become re-enrichment', () => {
  assert.throws(() => normalizeReviewAction({ ...card, comment: 'hold / re-enrich' }));
  assert.throws(() => normalizeReviewAction({ ...card, comment: 'hold 10 days' }));
});
test('reason and notes required for both hold and immediate re-enrichment', () => {
  assert.throws(() => normalizeReviewAction({ ...card, comment: 'hold', hold_notes: '' }));
  assert.throws(() => normalizeReviewAction({ ...card, comment: 're-enrich' }));
  assert.equal(normalizeReviewAction({ ...card, comment: 're-enrich', re_enrich_reason: 'wrong_entity', re_enrich_notes: 'Use the verified Polish site.' }).execution_action, 're-enrich');
});
test('controls preserve safe JSON and provide seven exact decisions', () => {
  const result = renderReviewControls([{ ...card, title: '</script><img>' }], 'batch');
  assert.equal((result.controls.get(1).match(/data-review-action=/g) || []).length, 7);
  assert.ok(result.handoff.includes('\\u003c/script>'));
  assert.ok(result.handoff.includes('localStorage.setItem'));
  assert.throws(() => renderReviewControls([card, card], 'batch'));
});
