/**
 * Dispatcher — Simulated Nudge Delivery Provider
 *
 * Simulates an async message delivery provider (WhatsApp/SMS gateway) with:
 *   - A realistic async delay (500–2000ms) mimicking network round-trips
 *   - A probabilistic delivery outcome: 'delivered' (60%) | 'sent' (25%) | 'failed' (15%)
 *   - Persistence of the delivery_status back to the action record in db.js
 *   - An audit log entry for the dispatch event
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️  What is SIMULATED here vs what is REAL:
 *
 *   REAL  ✅  Async behavior (actual Promise with setTimeout delay)
 *   REAL  ✅  Delivery status persistence (written to db.json via db.updateAction)
 *   REAL  ✅  Audit trail entry (stage: 'dispatch_nudge') visible in dashboard
 *   REAL  ✅  API contract (same interface a real provider SDK would expose)
 *
 *   SIMULATED 🔵  The transport layer — no actual HTTP call to WhatsApp/SMS API
 *   SIMULATED 🔵  Delivery confirmation — probabilistic, not from a real webhook
 *
 * In a production deployment, replace the body of dispatchNudge() with the
 * actual provider SDK call (e.g. Twilio, Gupshup, Kaleyra) and parse the
 * real delivery status from their webhook callback.
 * ─────────────────────────────────────────────────────────────────────
 */

import * as db from '../database/db.js';

/**
 * Probabilistic delivery outcome distribution:
 *   delivered: 60% — message was confirmed received by the recipient's device
 *   sent:      25% — message left our system but no confirmation yet
 *   failed:    15% — delivery failed (e.g. invalid number, carrier rejection)
 */
const DELIVERY_OUTCOMES = [
  { status: 'delivered', weight: 0.60 },
  { status: 'sent',      weight: 0.25 },
  { status: 'failed',    weight: 0.15 },
];

function pickDeliveryOutcome() {
  const rand = Math.random();
  let cumulative = 0;
  for (const outcome of DELIVERY_OUTCOMES) {
    cumulative += outcome.weight;
    if (rand < cumulative) return outcome.status;
  }
  return 'sent'; // fallback
}

/**
 * Simulates an async delivery delay between minMs and maxMs milliseconds.
 */
function simulateDeliveryDelay(minMs = 300, maxMs = 1500) {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Dispatches a nudge message to the customer via the simulated delivery provider.
 *
 * @param {string} paymentId   - The payment ID this nudge belongs to
 * @param {string} actionId    - The action record ID to update with delivery status
 * @param {string} customerName - Customer name for logging
 * @param {string} message     - The nudge message content (Hinglish WhatsApp copy)
 * @returns {Promise<{ delivery_status: string, provider_message_id: string }>}
 */
export async function dispatchNudge(paymentId, actionId, customerName, message) {
  const providerMessageId = `msg_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  
  console.log(`[DISPATCHER] Queuing nudge for ${customerName} (payment: ${paymentId})`);

  // Simulate async network round-trip to delivery provider
  await simulateDeliveryDelay();

  // Determine delivery outcome
  const deliveryStatus = pickDeliveryOutcome();

  // Persist delivery status back to the action record
  db.updateAction(actionId, { delivery_status: deliveryStatus });

  // Add dispatch event to audit trail
  db.addAuditLog(
    paymentId,
    'dispatch_nudge',
    `Nudge ${deliveryStatus.charAt(0).toUpperCase() + deliveryStatus.slice(1)}`,
    `Delivery provider returned status: "${deliveryStatus}" for provider_message_id: ${providerMessageId}. ` +
    `[Simulated transport — production would call WhatsApp/SMS API here]`
  );

  const statusEmoji = { delivered: '✅', sent: '📤', failed: '❌' }[deliveryStatus] || '📨';
  console.log(`[DISPATCHER] ${statusEmoji} Nudge for payment ${paymentId} → ${deliveryStatus} (${providerMessageId})`);

  return { delivery_status: deliveryStatus, provider_message_id: providerMessageId };
}
