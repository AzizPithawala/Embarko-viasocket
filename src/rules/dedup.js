'use strict';

// Event identity and deduplication (spec §5).
//
// Primary identity: stable event ID + client store ID.
//  - same event ID, same store       -> duplicate delivery (link to existing)
//  - same event ID, different store  -> separate event
//  - different event IDs, same order -> separate events
//  - missing event ID                -> uncertain; held for review. A matching
//    order ID / event type is shown as evidence but never proves a duplicate.

// incoming: { event_id, store_id, order_id, type }
// existing: array of { id, event_id, store_id, order_id, type, identity }
function classifyIncoming(incoming, existing) {
  const originals = existing.filter((e) => e.identity !== 'duplicate');

  if (!incoming.event_id) {
    const sameStore = originals.filter((e) => e.store_id === incoming.store_id);
    const closest =
      sameStore.find((e) => e.order_id === incoming.order_id && e.type === incoming.type) ||
      sameStore.find((e) => e.order_id === incoming.order_id) ||
      null;
    return { identity: 'uncertain', closest_match: closest ? closest.id : null };
  }

  const match = originals.find(
    (e) => e.event_id === incoming.event_id && e.store_id === incoming.store_id,
  );
  if (match) return { identity: 'duplicate', duplicate_of: match.id };
  return { identity: 'confirmed' };
}

module.exports = { classifyIncoming };
