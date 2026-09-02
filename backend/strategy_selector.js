/**
 * Strategy Selector - Deterministic State Machine for Dunning Interventions
 */

/**
 * Infers the customer's salary day of the month based on successful payment history.
 * Requires at least 2-3 successful payments to compute a mode day.
 * Returns the mode day (1-31) if inferred, or null.
 */
export function inferSalaryDay(successfulHistory) {
  if (!successfulHistory || successfulHistory.length < 2) {
    return null;
  }

  const dayFrequencies = {};
  for (const payment of successfulHistory) {
    const date = new Date(payment.timestamp);
    const day = date.getUTCDate();
    dayFrequencies[day] = (dayFrequencies[day] || 0) + 1;
  }

  let modeDay = null;
  let maxCount = 0;

  for (const dayStr in dayFrequencies) {
    const day = parseInt(dayStr, 10);
    const count = dayFrequencies[day];
    if (count > maxCount) {
      maxCount = count;
      modeDay = day;
    }
  }

  return modeDay;
}

/**
 * Calculates the next occurrence of a specific day of the month after a given reference date.
 */
export function calculateNextOccurrence(referenceDate, targetDay) {
  const ref = new Date(referenceDate);
  let year = ref.getUTCFullYear();
  let month = ref.getUTCMonth(); // 0-11
  const currentDay = ref.getUTCDate();

  // If the reference date's day of the month is strictly before the targetDay,
  // schedule it in the current month.
  // Otherwise, schedule it in the next month.
  if (currentDay >= targetDay) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }

  // Adjust targetDay if the target month has fewer days (e.g. Feb 30th -> Feb 28th)
  const daysInTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const adjustedDay = Math.min(targetDay, daysInTargetMonth);

  // Return Date at 10:00 AM UTC
  return new Date(Date.UTC(year, month, adjustedDay, 10, 0, 0));
}

/**
 * Selects the optimal recovery action based on payment status, classification,
 * actions history, and customer history.
 * 
 * Returns:
 * {
 *   action_type: 'retry' | 'nudge' | 'escalate' | 'halt',
 *   scheduled_for: string (ISO Timestamp),
 *   reasoning: string
 * }
 */
export function determineIntervention(payment, previousActions, successfulHistory, currentClassification = null, mlScore = null) {
  // Economic Floor Check:
  // Skip/escalate if the payment amount is strictly below the configured threshold (default: ₹100 / 10000 paise).
  const thresholdRupees = process.env.ECONOMIC_FLOOR_RUPEES ? parseFloat(process.env.ECONOMIC_FLOOR_RUPEES) : 100;
  const thresholdPaise = thresholdRupees * 100;
  if (payment.amount < thresholdPaise) {
    return {
      action_type: 'escalate',
      scheduled_for: new Date().toISOString(),
      reasoning: `Economic floor triggered: Payment amount ₹${(payment.amount / 100).toFixed(2)} is below the minimum threshold of ₹${thresholdRupees.toFixed(2)}. Aborting automated retries and escalating to manual billing review.`
    };
  }

  const rootCause = currentClassification ? currentClassification.root_cause : 'unknown';

  // 1. Enforce Dunning Stopping Rules
  // COUNT ONLY AUTOMATED (SYSTEM) RETRIES. Fixing the Polar Bug (#10811).
  const systemRetriesCount = previousActions.filter(
    a => a.action_type === 'retry' && a.trigger_source === 'system_dunning'
  ).length;

  if (systemRetriesCount >= 3) {
    return {
      action_type: 'halt',
      scheduled_for: new Date().toISOString(),
      reasoning: `Stopping rule triggered: Maximum automated retries (3) reached. Current count: ${systemRetriesCount}.`
    };
  }

  // Check for 2 consecutive risk blocks in the actions history
  // If the previous retry resulted in a risk_block or we have consecutive risk blocks, we halt.
  let consecutiveRiskBlocks = 0;
  if (rootCause === 'risk_block') {
    consecutiveRiskBlocks = 1;
    // Inspect previous action outcomes or previous failed payments to see if we already had a risk block
    // For simplicity, we check if there's any previous risk block in actions
    const hasPreviousRiskAction = previousActions.some(a => a.error_message && a.error_message.toLowerCase().includes('risk'));
    if (hasPreviousRiskAction) {
      consecutiveRiskBlocks = 2;
    }
  }

  if (consecutiveRiskBlocks >= 2) {
    return {
      action_type: 'halt',
      scheduled_for: new Date().toISOString(),
      reasoning: 'Stopping rule triggered: 2 consecutive risk_block classifications detected.'
    };
  }

  // 2. Intervention mapping per root cause
  switch (rootCause) {
    case 'risk_block':
      // Halt automated retries, escalate immediately
      return {
        action_type: 'escalate',
        scheduled_for: new Date().toISOString(),
        reasoning: 'Security/Risk block detected. Automatic retries halted to prevent mandate spam. Escalated to billing operations team.'
      };

    case 'expired_instrument':
      // No point in retrying an expired card. Send nudge to update details.
      return {
        action_type: 'nudge',
        scheduled_for: new Date().toISOString(),
        reasoning: 'Payment instrument is expired or inactive. Retries halted. WhatsApp nudge queued asking customer to update their payment method.'
      };

    case 'bank_timeout': {
      // Short cooldown retry. Attempt number determines delay.
      let cooldownMs = 5 * 60 * 1000; // Default 5 minutes
      let delayText = '5 minutes';

      if (systemRetriesCount === 1) {
        cooldownMs = 60 * 60 * 1000; // 1 hour
        delayText = '1 hour';
      } else if (systemRetriesCount === 2) {
        cooldownMs = 24 * 60 * 60 * 1000; // 24 hours
        delayText = '24 hours';
      }

      const scheduledFor = new Date(new Date(payment.timestamp).getTime() + cooldownMs);
      return {
        action_type: 'retry',
        scheduled_for: scheduledFor.toISOString(),
        reasoning: `Transient bank/gateway timeout detected. Scheduling automated retry #${systemRetriesCount + 1} after a cooldown of ${delayText}.`
      };
    }

    case 'insufficient_funds': {
      // --- ML Advisory Signal ---
      // If the ML scorer has flagged very low recovery probability for this payment,
      // escalate immediately instead of scheduling a retry. This prevents wasted
      // retry attempts on payments the model predicts are highly unlikely to recover.
      // The ML Score is advisory only — we log it explicitly so it is auditable.
      const ML_LOW_PROB_THRESHOLD = 0.15;
      if (mlScore !== null && mlScore < ML_LOW_PROB_THRESHOLD) {
        return {
          action_type: 'escalate',
          scheduled_for: new Date().toISOString(),
          reasoning: `Insufficient funds detected. [ML Score: ${mlScore.toFixed(3)} — below threshold ${ML_LOW_PROB_THRESHOLD}] ML advisory signal indicates very low recovery probability. Policy Engine overrides salary-cycle retry and escalates to billing review. (Advisory only — ML does not move money.)`
        };
      }

      // Inferred salary day logic (Primary Micro-innovation)
      const salaryDay = inferSalaryDay(successfulHistory);
      let scheduledForDate;
      let reasoning;
      const mlNote = mlScore !== null ? ` [ML Score: ${mlScore.toFixed(3)}]` : '';

      if (salaryDay !== null) {
        scheduledForDate = calculateNextOccurrence(payment.timestamp, salaryDay);
        reasoning = `Insufficient funds detected.${mlNote} Inferred customer salary cycle is on Day ${salaryDay} of the month. Scheduling retry #${systemRetriesCount + 1} on the salary day: ${scheduledForDate.toISOString().slice(0, 10)}.`;
      } else {
        // Fallback to industry standard T+3 days
        scheduledForDate = new Date(new Date(payment.timestamp).getTime() + 3 * 24 * 60 * 60 * 1000);
        reasoning = `Insufficient funds detected.${mlNote} No historical payments found to infer salary cycle. Defaulting to T+3 retry #${systemRetriesCount + 1} on ${scheduledForDate.toISOString().slice(0, 10)}.`;
      }

      return {
        action_type: 'retry',
        scheduled_for: scheduledForDate.toISOString(),
        reasoning
      };
    }

    case 'unknown':
    default:
      // Default to manual review escalation
      return {
        action_type: 'escalate',
        scheduled_for: new Date().toISOString(),
        reasoning: 'Payment failed due to unknown/unmapped decline reason. Escalating to billing operations.'
      };
  }
}
