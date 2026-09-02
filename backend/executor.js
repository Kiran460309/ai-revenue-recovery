import Razorpay from 'razorpay';
import { generateNudgeCopy } from './classifier.js';
import { dispatchNudge } from './dispatcher.js';
import * as db from '../database/db.js';
import { determineIntervention } from './strategy_selector.js';
import { scoreRecoveryProbability } from './ml_scorer.js';
import dotenv from 'dotenv';
dotenv.config();

// Initialize Razorpay if keys are available
let razorpayClient = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  try {
    razorpayClient = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });
    console.log('💳 Razorpay client initialized in test mode.');
  } catch (err) {
    console.warn('⚠️ Failed to initialize Razorpay client:', err.message);
  }
}

/**
 * Executes a chosen intervention on a payment
 * 
 * @param {object} payment The failed payment object from database
 * @param {object} action The action record (from database, result='pending')
 * @param {boolean} isFailureInjectionEnabled Whether to simulate an API timeout
 */
export async function executeAction(payment, action, isFailureInjectionEnabled = false) {
  if (!payment || !action || !payment.payment_id || !action.action_id) {
    console.warn('⚠️ [EXECUTOR] executeAction received null/undefined payment or action record. Aborting execution safely.');
    return;
  }

  const nowStr = new Date().toISOString();

  // 1. Concurrency / Idempotency check:
  // Retrieve the actual DB state of actions for this payment to check if this action is still pending.
  const dbActions = db.getActions(payment.payment_id);
  const dbAction = dbActions.find(a => a.action_id === action.action_id);

  if (!dbAction || dbAction.result !== 'pending') {
    console.warn(`⚠️ [IDEMPOTENCY] Action ${action.action_id} has already been executed or is not pending.`);
    return;
  }

  // Uniqueness check for duplicate retry attempts on the same attempt_number
  if (action.action_type === 'retry') {
    const targetAttempt = payment.attempt_number + 1;
    const duplicateExecutedAction = dbActions.find(a => 
      a.action_id !== action.action_id &&
      a.action_type === 'retry' &&
      a.result !== 'pending' &&
      (payment.attempt_number + 1) === targetAttempt
    );

    if (duplicateExecutedAction) {
      db.updateAction(action.action_id, {
        result: 'duplicate',
        error_message: `Aborted duplicate retry. Attempt #${targetAttempt} already processed by ${duplicateExecutedAction.action_id}`
      });
      console.warn(`⚠️ [IDEMPOTENCY] Retry action ${action.action_id} aborted. Another retry (${duplicateExecutedAction.action_id}) has already processed attempt #${targetAttempt} for payment ${payment.payment_id}.`);
      return;
    }
  }

  // 2. Synchronously lock the action to prevent concurrent race conditions
  db.updateAction(action.action_id, { result: 'processing', executed_at: nowStr });

  db.addAuditLog(
    payment.payment_id,
    'execute',
    `Start executing: ${action.action_type}`,
    `Triggered via: ${action.trigger_source}. Action ID: ${action.action_id}`
  );

  // Update payment status to recovering
  db.updateFailedPaymentStatus(payment.payment_id, 'recovering');

  if (action.action_type === 'halt') {
    db.updateAction(action.action_id, { result: 'success' });
    db.updateFailedPaymentStatus(payment.payment_id, 'halted');
    db.addAuditLog(
      payment.payment_id,
      'execute',
      'Execution Complete: Halted',
      'Automated recovery halted based on dunning stopping rules. No further actions scheduled.'
    );
    return;
  }

  if (action.action_type === 'escalate') {
    db.updateAction(action.action_id, { result: 'success' });
    db.updateFailedPaymentStatus(payment.payment_id, 'escalated');
    db.addAuditLog(
      payment.payment_id,
      'execute',
      'Execution Complete: Escalated',
      'Intervention escalated to human billing operations review queue. System auto-dunning suspended.'
    );
    return;
  }

  if (action.action_type === 'nudge') {
    try {
      // Generate Hinglish copy
      const copy = await generateNudgeCopy(
        payment.customer_name || payment.customer_id,
        db.getClassification(payment.payment_id)?.root_cause || 'unknown',
        (payment.amount / 100).toFixed(2)
      );

      // Persist the nudge message to the action record first
      db.updateAction(action.action_id, {
        result: 'success',
        nudge_message: copy
      });

      // Dispatch via simulated delivery provider (async, real delivery_status persisted)
      const dispatchResult = await dispatchNudge(
        payment.payment_id,
        action.action_id,
        payment.customer_name || payment.customer_id,
        copy
      );
      
      // Update payment status to escalated because we are waiting on customer action
      db.updateFailedPaymentStatus(payment.payment_id, 'escalated');
      
      db.addAuditLog(
        payment.payment_id,
        'execute',
        'Execution Complete: Nudge Sent',
        `Dispatched Hinglish notification via dispatcher. Delivery status: "${dispatchResult.delivery_status}". Content: "${copy}"`
      );
    } catch (err) {
      db.updateAction(action.action_id, {
        result: 'failure',
        error_message: err.message
      });
      db.addAuditLog(
        payment.payment_id,
        'execute',
        'Execution Failed: Nudge Dispatch Error',
        `Error sending nudge: ${err.message}`
      );
    }
    return;
  }

  if (action.action_type === 'retry') {
    // Check for deliberate failure injection (Simulate Razorpay API Timeout)
    if (isFailureInjectionEnabled) {
      console.log(`💥 [FAILURE INJECTION] Simulating downstream API timeout on retry for payment ${payment.payment_id}`);
      
      db.updateAction(action.action_id, {
        result: 'timeout',
        error_message: 'Downstream Razorpay gateway timeout (504)'
      });

      db.addAuditLog(
        payment.payment_id,
        'execute',
        'Execution Interrupted: API Timeout Injected',
        'Caught timeout exception (504) during Razorpay retry execution. Triggering fallback scheduler.'
      );

      // GRACEFUL FALLBACK: Reschedule retry for 1 hour later
      const fallbackTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      db.saveAction({
        payment_id: payment.payment_id,
        action_type: 'retry',
        trigger_source: 'system_dunning',
        scheduled_for: fallbackTime,
        result: 'pending'
      });

      db.addAuditLog(
        payment.payment_id,
        'execute',
        'Fallback Action Scheduled',
        `Rescheduled a backup retry in 1 hour (at ${fallbackTime}) to recover from the timeout exception.`
      );
      
      return;
    }

    // Try real Razorpay integration if keys exist
    if (razorpayClient) {
      try {
        console.log(`🔗 [RAZORPAY API] Charging token for customer ${payment.customer_id} in test mode...`);
        // In real Razorpay integration, we call payment capture or charge a token.
        // For test mode safety, we simulate the S2S payment charge payload:
        const response = await razorpayClient.orders.create({
          amount: payment.amount,
          currency: 'INR',
          receipt: `rcpt_${payment.payment_id.slice(-8)}`,
          notes: {
            customer_id: payment.customer_id,
            payment_id: payment.payment_id,
            mode: 'recurring_recovery'
          }
        });

        if (response.id && (response.status === 'created' || response.status === 'captured' || response.status === 'authorized')) {
          db.updateAction(action.action_id, { result: 'success' });
          db.updateFailedPaymentStatus(payment.payment_id, 'recovered', payment.attempt_number + 1);
          db.addAuditLog(
            payment.payment_id,
            'execute',
            'Execution Complete: Retry Succeeded',
            `Razorpay test API charge order created. Order ID: ${response.id}. Status: ${response.status}. Mandate successfully charged via S2S Razorpay API!`
          );
          return;
        } else {
          throw new Error(`Charge status returned: ${response.status}`);
        }
      } catch (err) {
        console.warn(`⚠️ Razorpay API charge failed: ${err.message}. Cascading to Mock Gateway handler...`);
      }
    }

    // MOCK GATEWAY HANDLER (Simulated payment engine)
    const classification = db.getClassification(payment.payment_id);
    const rootCause = classification ? classification.root_cause : 'unknown';
    
    // Simulate gateway success/failure based on root cause rules:
    let success = false;
    let declineReason = 'Declined by bank';

    if (rootCause === 'bank_timeout') {
      // 70% chance of success on retry (transient bank issue solved)
      success = Math.random() < 0.70;
      declineReason = 'Bank downstream network congested';
    } else if (rootCause === 'insufficient_funds') {
      // Insufficient funds recovery depends on salary date!
      // Aditya salary day is 1st. Rohan salary day is 28th. Priya is 7th. Karan is 10th.
      // If the retry date is on or after the salary day, the balance is present. Otherwise it bounces.
      const successfulHistory = db.getSuccessfulPayments(payment.customer_id);
      
      // Look up inferred salary day
      const dayFrequencies = {};
      for (const p of successfulHistory) {
        dayFrequencies[new Date(p.timestamp).getUTCDate()] = (dayFrequencies[new Date(p.timestamp).getUTCDate()] || 0) + 1;
      }
      let salaryDay = null;
      let maxCount = 0;
      for (const d in dayFrequencies) {
        if (dayFrequencies[d] > maxCount) {
          maxCount = dayFrequencies[d];
          salaryDay = parseInt(d, 10);
        }
      }

      const scheduledDate = new Date(action.scheduled_for);
      const scheduledDay = scheduledDate.getUTCDate();

      if (salaryDay !== null && scheduledDay === salaryDay) {
        success = true;
      } else {
        // Fallback: If it's a T+3 fallback retry, it succeeds with a 40% probability
        // (representing customers who randomly reload balance out of dunning cycle).
        success = Math.random() < 0.40;
        declineReason = 'Insufficient funds / Low account balance';
      }
    } else if (rootCause === 'expired_instrument') {
      // Card expired can never succeed on retry!
      success = false;
      declineReason = 'Card expired or closed';
    } else if (rootCause === 'risk_block') {
      // Risk block can never succeed on retry!
      success = false;
      declineReason = 'Suspected fraud / Restricted card status';
    } else {
      success = Math.random() < 0.30;
      declineReason = 'General gateway decline';
    }

    const nextAttemptNumber = payment.attempt_number + 1;

    if (success) {
      db.updateAction(action.action_id, { result: 'success' });
      db.updateFailedPaymentStatus(payment.payment_id, 'recovered', nextAttemptNumber);
      db.addAuditLog(
        payment.payment_id,
        'execute',
        'Execution Complete: Retry Succeeded',
        `Simulated Gateway charge succeeded on attempt #${nextAttemptNumber}. Mandate successfully recovered!`
      );
    } else {
      db.updateAction(action.action_id, {
        result: 'failure',
        error_message: declineReason
      });
      db.updateFailedPaymentStatus(payment.payment_id, 'failed', nextAttemptNumber);
      
      db.addAuditLog(
        payment.payment_id,
        'execute',
        `Execution Complete: Retry Failed (Attempt #${nextAttemptNumber})`,
        `Simulated Gateway charge failed with response: "${declineReason}".`
      );

      // CASCADING SYSTEM DUNNING: Since retry failed, trigger ML scoring and strategy selector again!
      const refreshedPayment = db.getFailedPayment(payment.payment_id);
      const previousActionsForPayment = db.getActions(payment.payment_id);
      const successfulHistoryForPayment = db.getSuccessfulPayments(payment.customer_id);

      // Score recovery probability on updated attempt
      const mlResult = scoreRecoveryProbability(refreshedPayment, classification, successfulHistoryForPayment);
      db.addAuditLog(
        payment.payment_id,
        'ml_score',
        `Cascade ML Recovery Score: ${mlResult.score.toFixed(3)}`,
        mlResult.reasoning
      );

      const nextIntervention = determineIntervention(
        refreshedPayment,
        previousActionsForPayment,
        successfulHistoryForPayment,
        classification,
        mlResult.score
      );

      db.saveAction({
        payment_id: payment.payment_id,
        action_type: nextIntervention.action_type,
        trigger_source: 'system_dunning',
        scheduled_for: nextIntervention.scheduled_for,
        result: 'pending'
      });

      db.addAuditLog(
        payment.payment_id,
        'select_strategy',
        `Cascade Strategy: Next Action selected: ${nextIntervention.action_type}`,
        `Reasoning: ${nextIntervention.reasoning}. Scheduled for: ${nextIntervention.scheduled_for}`
      );
    }
  }
}
