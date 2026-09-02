import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import * as db from '../database/db.js';
import { classifyAsync } from './classifier.js';
import { determineIntervention } from './strategy_selector.js';
import { executeAction } from './executor.js';
import { runBaselineSimulation } from './baseline_simulator.js';
import { scoreRecoveryProbability } from './ml_scorer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend static files
const frontendDir = path.resolve(__dirname, '../frontend');
app.use(express.static(frontendDir));

app.get('/', (req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

// Global failure injection flag
let isFailureInjectionEnabled = false;

// Store last batch run results for baseline comparison endpoint
let lastBatchResults = null;

// Initialize Database
db.initDB();

/**
 * Ingest single failed payment event
 */
app.post('/api/events/failed-payment', async (req, res) => {
  const { payment_id, customer_id, customer_name, amount, failure_code, gateway_message, timestamp } = req.body;

  if (!payment_id || !customer_id || !amount) {
    return res.status(400).json({ error: 'Missing required fields: payment_id, customer_id, amount' });
  }

  try {
    // 1. Ingest Failed Payment
    const payment = {
      payment_id,
      customer_id,
      customer_name: customer_name || customer_id,
      amount: parseInt(amount, 10),
      failure_code,
      gateway_message: gateway_message || '',
      attempt_number: 0,
      status: 'failed',
      timestamp: timestamp || new Date().toISOString()
    };
    db.saveFailedPayment(payment);
    db.addAuditLog(payment_id, 'ingest', 'Ingested failed payment', `Amount: ₹${(payment.amount / 100).toFixed(2)}. Code: ${failure_code}.`);

    // 2. Classify Root Cause
    const classification = await classifyAsync(payment.failure_code, payment.gateway_message);
    db.saveClassification({
      payment_id,
      root_cause: classification.root_cause,
      confidence: classification.confidence,
      method: classification.method
    });
    db.addAuditLog(
      payment_id,
      'classify',
      `Classified as ${classification.root_cause}`,
      `Method: ${classification.method}. Confidence: ${classification.confidence}`
    );

    // 3. Score recovery probability via ML scorer (advisory signal only)
    const successfulHistory = db.getSuccessfulPayments(customer_id);
    const mlResult = scoreRecoveryProbability(payment, classification, successfulHistory);
    db.addAuditLog(
      payment_id,
      'ml_score',
      `ML Recovery Score: ${mlResult.score.toFixed(3)}`,
      mlResult.reasoning
    );

    // 4. Select Strategy & Schedule Action
    const intervention = determineIntervention(payment, [], successfulHistory, classification, mlResult.score);

    db.saveAction({
      payment_id,
      action_type: intervention.action_type,
      trigger_source: 'system_dunning',
      scheduled_for: intervention.scheduled_for,
      result: 'pending'
    });

    db.addAuditLog(
      payment_id,
      'select_strategy',
      `Scheduled action: ${intervention.action_type}`,
      `Reasoning: ${intervention.reasoning}. Scheduled for: ${intervention.scheduled_for}`
    );

    res.json({ success: true, message: 'Event processed and strategy scheduled.' });
  } catch (err) {
    console.error('Error in failed-payment ingestion:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Get payment classification details
 */
app.get('/api/payments/:id/classification', (req, res) => {
  const classification = db.getClassification(req.params.id);
  if (!classification) {
    return res.status(404).json({ error: 'Classification not found' });
  }
  res.json(classification);
});

/**
 * Get visual audit trail for a payment
 */
app.get('/api/payments/:id/audit-trail', (req, res) => {
  const payment = db.getFailedPayment(req.params.id);
  if (!payment) {
    return res.status(404).json({ error: 'Payment not found' });
  }
  
  const classification = db.getClassification(req.params.id) || null;
  const actions = db.getActions(req.params.id);
  const auditLogs = db.getAuditLog(req.params.id);

  res.json({
    payment,
    classification,
    actions,
    auditLogs
  });
});

/**
 * Get recent global audit logs
 */
app.get('/api/audit-logs', (req, res) => {
  const logs = db.getAllAuditLogs();
  const sortedLogs = [...logs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 20);
  res.json(sortedLogs);
});

/**
 * Nudges feed: all dispatched nudge actions with delivery status
 * Aliased to both /api/nudges and /api/nudges/feed
 */
const handleNudgesFeed = (req, res) => {
  try {
    const payments = db.getFailedPayments();
    const nudgeActions = [];

    for (const p of payments) {
      const actions = db.getActions(p.payment_id);
      for (const a of actions) {
        if (a.action_type === 'nudge' && a.nudge_message) {
          nudgeActions.push({
            action_id: a.action_id,
            payment_id: p.payment_id,
            customer_name: p.customer_name || p.customer_id,
            nudge_message: a.nudge_message,
            delivery_status: a.delivery_status || 'pending',
            executed_at: a.executed_at,
            result: a.result
          });
        }
      }
    }

    // Sort newest first
    nudgeActions.sort((a, b) => new Date(b.executed_at || 0) - new Date(a.executed_at || 0));
    res.json(nudgeActions);
  } catch (err) {
    console.error('Error fetching nudges feed:', err);
    res.status(500).json({ error: 'Failed to fetch nudges feed' });
  }
};

app.get('/api/nudges/feed', handleNudgesFeed);
app.get('/api/nudges', handleNudgesFeed);

/**
 * Get recovery and false-stop statistics report
 */
app.get('/api/report/recovery-rate', (req, res) => {
  const payments = db.getFailedPayments();
  
  let totalAtRisk = 0;
  let totalRecovered = 0;
  let activeCount = 0;
  let haltedCount = 0;
  let escalatedCount = 0;

  // Breakdown by cause
  const breakdown = {
    insufficient_funds: { atRisk: 0, recovered: 0, count: 0, recoveredCount: 0 },
    expired_instrument: { atRisk: 0, recovered: 0, count: 0, recoveredCount: 0 },
    bank_timeout: { atRisk: 0, recovered: 0, count: 0, recoveredCount: 0 },
    risk_block: { atRisk: 0, recovered: 0, count: 0, recoveredCount: 0 },
    unknown: { atRisk: 0, recovered: 0, count: 0, recoveredCount: 0 }
  };

  for (const p of payments) {
    const classification = db.getClassification(p.payment_id);
    const cause = classification ? classification.root_cause : 'unknown';

    totalAtRisk += p.amount;
    
    if (p.status === 'recovered') {
      totalRecovered += p.amount;
      breakdown[cause].recovered += p.amount;
      breakdown[cause].recoveredCount += 1;
    }

    breakdown[cause].atRisk += p.amount;
    breakdown[cause].count += 1;

    if (p.status === 'recovering' || p.status === 'failed') {
      activeCount += 1;
    } else if (p.status === 'halted') {
      haltedCount += 1;
    } else if (p.status === 'escalated') {
      escalatedCount += 1;
    }
  }

  // Formatting response
  const report = {
    overall: {
      totalAtRiskRupees: (totalAtRisk / 100).toFixed(2),
      totalRecoveredRupees: (totalRecovered / 100).toFixed(2),
      recoveryRatePercent: totalAtRisk > 0 ? ((totalRecovered / totalAtRisk) * 100).toFixed(1) : '0.0',
      activeCount,
      haltedCount,
      escalatedCount,
      totalCount: payments.length,
      falseStopRatePercent: payments.length > 0 ? ((haltedCount / payments.length) * 100).toFixed(1) : '0.0'
    },
    breakdown: Object.keys(breakdown).map(cause => ({
      root_cause: cause,
      atRiskRupees: (breakdown[cause].atRisk / 100).toFixed(2),
      recoveredRupees: (breakdown[cause].recovered / 100).toFixed(2),
      recoveryRatePercent: breakdown[cause].atRisk > 0 
        ? ((breakdown[cause].recovered / breakdown[cause].atRisk) * 100).toFixed(1) 
        : '0.0',
      count: breakdown[cause].count,
      recoveredCount: breakdown[cause].recoveredCount
    })),
    payments: payments.map(p => {
      const classification = db.getClassification(p.payment_id);
      return {
        ...p,
        root_cause: classification ? classification.root_cause : 'unknown'
      };
    })
  };

  res.json(report);
});

/**
 * Baseline comparison report: AI system vs. naive fixed-retry strategy
 */
app.get('/api/report/baseline-comparison', (req, res) => {
  try {
    const payments = db.getFailedPayments();
    const classifications = payments.map(p => db.getClassification(p.payment_id)).filter(Boolean);

    // Build history map for baseline simulator
    const customerIds = [...new Set(payments.map(p => p.customer_id))];
    const historyByCustomer = {};
    for (const cid of customerIds) {
      historyByCustomer[cid] = db.getSuccessfulPayments(cid);
    }

    // Run naive baseline on same dataset
    const baselineResult = runBaselineSimulation(payments, classifications, historyByCustomer);

    // AI system's actual recovery rate from live DB
    let totalPaise = 0, recoveredPaise = 0;
    for (const p of payments) {
      totalPaise += p.amount;
      if (p.status === 'recovered') recoveredPaise += p.amount;
    }
    const aiRecoveryRatePercent = totalPaise > 0
      ? ((recoveredPaise / totalPaise) * 100).toFixed(1)
      : '0.0';

    const upliftPercent = totalPaise > 0
      ? (parseFloat(aiRecoveryRatePercent) - parseFloat(baselineResult.naiveRecoveryRatePercent)).toFixed(1)
      : '0.0';

    // Holdout group data (populated by run-batch, Step 4)
    const holdout = lastBatchResults ? lastBatchResults.holdout : null;

    res.json({
      aiRecoveryRatePercent,
      naiveRecoveryRatePercent: baselineResult.naiveRecoveryRatePercent,
      upliftPercent,
      aiRecoveredRupees: (recoveredPaise / 100).toFixed(2),
      naiveRecoveredRupees: baselineResult.naiveRecoveredRupees,
      totalRupees: (totalPaise / 100).toFixed(2),
      totalPaymentsCount: payments.length,
      holdout
    });
  } catch (err) {
    console.error('Error computing baseline comparison:', err);
    res.status(500).json({ error: 'Failed to compute baseline comparison' });
  }
});

/**
 * Toggle failure injection
 */
app.post('/api/test/inject-failure', (req, res) => {
  isFailureInjectionEnabled = req.body.enabled === true;
  res.json({ success: true, isFailureInjectionEnabled });
});

/**
 * Customer manual retry action
 */
app.post('/api/payments/:id/manual-retry', async (req, res) => {
  const payment = db.getFailedPayment(req.params.id);
  if (!payment) {
    return res.status(404).json({ error: 'Payment not found' });
  }

  try {
    // Generate manual retry action
    const action = {
      payment_id: payment.payment_id,
      action_type: 'retry',
      trigger_source: 'customer_manual',
      scheduled_for: new Date().toISOString()
    };
    db.saveAction(action);

    // Get the newly saved action object to execute it
    const dbActions = db.getActions(payment.payment_id);
    const pendingAction = dbActions.find(a => a.result === 'pending' && a.trigger_source === 'customer_manual');

    if (pendingAction) {
      await executeAction(payment, pendingAction, isFailureInjectionEnabled);
    }

    const updatedPayment = db.getFailedPayment(payment.payment_id);
    res.json({
      success: updatedPayment.status === 'recovered',
      status: updatedPayment.status,
      message: updatedPayment.status === 'recovered' ? 'Manual retry succeeded!' : 'Manual retry failed.'
    });
  } catch (err) {
    console.error('Error executing manual retry:', err);
    res.status(500).json({ error: 'Failed to process manual retry' });
  }
});

/**
 * Ingest a batch of 20 synthetic transactions and simulate their full dunning lifecycle
 */
export async function executeBatchSimulation() {
  // Reset Database
  db.initDB(true);

  // Synthetic transaction distribution (Grounded split: 40% timeout, 50% funds, 5% expired, 5% risk block)
  // 20 total transactions: 8 timeouts, 10 insufficient funds, 1 expired, 1 risk block
  const syntheticPayments = [
    // Insufficient Funds: Aditya (salary day = 1st)
    { payment_id: 'pay_funds_aditya_1', customer_id: 'cust_aditya', customer_name: 'Aditya Sharma', amount: 250000, failure_code: 'BAD_REQUEST_INSUFFICIENT_FUNDS', gateway_message: 'Low balance', timestamp: '2026-08-05T12:00:00.000Z' },
    { payment_id: 'pay_funds_aditya_2', customer_id: 'cust_aditya', customer_name: 'Aditya Sharma', amount: 120000, failure_code: 'BAD_REQUEST_INSUFFICIENT_FUNDS', gateway_message: 'Insufficient balance', timestamp: '2026-08-15T12:00:00.000Z' },
    
    // Insufficient Funds: Priya (salary day = 7th)
    { payment_id: 'pay_funds_priya_1', customer_id: 'cust_priya', customer_name: 'Priya Patel', amount: 150000, failure_code: 'BAD_REQUEST_INSUFFICIENT_FUNDS', gateway_message: 'Low balance', timestamp: '2026-08-04T12:00:00.000Z' },
    { payment_id: 'pay_funds_priya_2', customer_id: 'cust_priya', customer_name: 'Priya Patel', amount: 180000, failure_code: 'BAD_REQUEST_INSUFFICIENT_FUNDS', gateway_message: 'Low balance', timestamp: '2026-08-12T12:00:00.000Z' },

    // Insufficient Funds: Rohan (salary day = 28th)
    { payment_id: 'pay_funds_rohan_1', customer_id: 'cust_rohan', customer_name: 'Rohan Verma', amount: 500000, failure_code: 'BAD_REQUEST_INSUFFICIENT_FUNDS', gateway_message: 'Low balance', timestamp: '2026-08-20T12:00:00.000Z' },
    { payment_id: 'pay_funds_rohan_2', customer_id: 'cust_rohan', customer_name: 'Rohan Verma', amount: 350000, failure_code: 'BAD_REQUEST_INSUFFICIENT_FUNDS', gateway_message: 'Low balance', timestamp: '2026-08-29T12:00:00.000Z' },

    // Insufficient Funds: Karan (salary day = 10th)
    { payment_id: 'pay_funds_karan_1', customer_id: 'cust_karan', customer_name: 'Karan Johar', amount: 9900, failure_code: 'BAD_REQUEST_INSUFFICIENT_FUNDS', gateway_message: 'Low balance', timestamp: '2026-08-02T12:00:00.000Z' },
    { payment_id: 'pay_funds_karan_2', customer_id: 'cust_karan', customer_name: 'Karan Johar', amount: 9900, failure_code: 'BAD_REQUEST_INSUFFICIENT_FUNDS', gateway_message: 'Low balance', timestamp: '2026-08-14T12:00:00.000Z' },

    // Insufficient Funds: Sneha (no historical payments to test T+3 fallback)
    { payment_id: 'pay_funds_sneha_1', customer_id: 'cust_sneha', customer_name: 'Sneha Reddy', amount: 49900, failure_code: 'BAD_REQUEST_INSUFFICIENT_FUNDS', gateway_message: 'Low balance', timestamp: '2026-08-10T12:00:00.000Z' },
    { payment_id: 'pay_funds_sneha_2', customer_id: 'cust_sneha', customer_name: 'Sneha Reddy', amount: 49900, failure_code: 'BAD_REQUEST_INSUFFICIENT_FUNDS', gateway_message: 'Low balance', timestamp: '2026-08-20T12:00:00.000Z' },

    // Bank Timeouts (8 Transactions)
    { payment_id: 'pay_time_aditya', customer_id: 'cust_aditya', customer_name: 'Aditya Sharma', amount: 250000, failure_code: 'BAD_REQUEST_PAYMENT_TIMED_OUT', gateway_message: 'Bank connection timed out', timestamp: '2026-08-01T12:00:00.000Z' },
    { payment_id: 'pay_time_priya', customer_id: 'cust_priya', customer_name: 'Priya Patel', amount: 150000, failure_code: 'BAD_REQUEST_PAYMENT_TIMED_OUT', gateway_message: 'Gateway downstream timed out', timestamp: '2026-08-02T12:00:00.000Z' },
    { payment_id: 'pay_time_rohan', customer_id: 'cust_rohan', customer_name: 'Rohan Verma', amount: 500000, failure_code: 'BAD_REQUEST_PAYMENT_TIMED_OUT', gateway_message: 'Bank timed out', timestamp: '2026-08-03T12:00:00.000Z' },
    { payment_id: 'pay_time_karan', customer_id: 'cust_karan', customer_name: 'Karan Johar', amount: 9900, failure_code: 'BAD_REQUEST_PAYMENT_TIMED_OUT', gateway_message: 'Connection timed out', timestamp: '2026-08-04T12:00:00.000Z' },
    { payment_id: 'pay_time_sneha', customer_id: 'cust_sneha', customer_name: 'Sneha Reddy', amount: 49900, failure_code: 'BAD_REQUEST_PAYMENT_TIMED_OUT', gateway_message: 'Bank timeout error', timestamp: '2026-08-05T12:00:00.000Z' },
    { payment_id: 'pay_time_gen_1', customer_id: 'cust_aditya', customer_name: 'Aditya Sharma', amount: 50000, failure_code: 'payment_timed_out', gateway_message: 'Bank connection lost', timestamp: '2026-08-06T12:00:00.000Z' },
    { payment_id: 'pay_time_gen_2', customer_id: 'cust_priya', customer_name: 'Priya Patel', amount: 30000, failure_code: 'payment_timed_out', gateway_message: 'Bank connection lost', timestamp: '2026-08-07T12:00:00.000Z' },
    { payment_id: 'pay_time_gen_3', customer_id: 'cust_rohan', customer_name: 'Rohan Verma', amount: 80000, failure_code: 'payment_timed_out', gateway_message: 'Bank connection lost', timestamp: '2026-08-08T12:00:00.000Z' },

    // Expired Card (1 Transaction)
    { payment_id: 'pay_exp_priya', customer_id: 'cust_priya', customer_name: 'Priya Patel', amount: 150000, failure_code: 'BAD_REQUEST_PAYMENT_CARD_EXPIRED', gateway_message: 'Card validity expired', timestamp: '2026-08-11T12:00:00.000Z' },

    // Risk Block (1 Transaction)
    { payment_id: 'pay_risk_aditya', customer_id: 'cust_aditya', customer_name: 'Aditya Sharma', amount: 250000, failure_code: 'BAD_REQUEST_PAYMENT_RISK_THRESHOLD_EXCEEDED', gateway_message: 'Transaction flagged as risk block', timestamp: '2026-08-12T12:00:00.000Z' }
  ];

  // ── HOLDOUT GROUP ASSIGNMENT (Step 4: Incrementality Holdout) ──────────────
  const controlGroupIds = new Set([
    'pay_funds_priya_2', // Insufficient funds control
    'pay_time_karan',    // Bank timeout control
    'pay_time_gen_2'     // General timeout control
  ]);

  // Ingest the initial failed payments
  for (const p of syntheticPayments) {
    db.saveFailedPayment(p);
    db.addAuditLog(p.payment_id, 'ingest', 'Ingested failed payment', `Ingested simulated transaction. Amount: ₹${(p.amount / 100).toFixed(2)}.`);

    const classification = await classifyAsync(p.failure_code, p.gateway_message);
    db.saveClassification({
      payment_id: p.payment_id,
      root_cause: classification.root_cause,
      confidence: classification.confidence,
      method: classification.method
    });
    db.addAuditLog(
      p.payment_id,
      'classify',
      `Classified as ${classification.root_cause}`,
      `Rule mapping identified category. Confidence: ${classification.confidence}`
    );

    const successfulHistory = db.getSuccessfulPayments(p.customer_id);

    // ── HOLDOUT: skip intervention for control group ────────────────────────
    if (controlGroupIds.has(p.payment_id)) {
      db.addAuditLog(
        p.payment_id,
        'holdout',
        'Control Group: No Intervention',
        'Payment assigned to holdout control group. Strategy selector skipped — observing self-recovery only.'
      );
      db.updateFailedPaymentStatus(p.payment_id, 'failed');
      continue;
    }

    // ML Advisory Score
    const mlResult = scoreRecoveryProbability(p, classification, successfulHistory);
    db.addAuditLog(
      p.payment_id,
      'ml_score',
      `ML Recovery Score: ${mlResult.score.toFixed(3)}`,
      mlResult.reasoning
    );

    // Strategy Selection
    const intervention = determineIntervention(
      p,
      [],
      successfulHistory,
      classification,
      mlResult.score
    );

    db.saveAction({
      payment_id: p.payment_id,
      action_type: intervention.action_type,
      trigger_source: 'system_dunning',
      scheduled_for: intervention.scheduled_for,
      result: 'pending'
    });

    db.addAuditLog(
      p.payment_id,
      'select_strategy',
      `Scheduled initial action: ${intervention.action_type}`,
      `Reasoning: ${intervention.reasoning}. Target Execution: ${intervention.scheduled_for}`
    );
  }

  // SIMULATOR LOOP: Synchronously resolve the dunning pipeline step-by-step
  let pendingActionsExist = true;
  let loopSafetyCounter = 0;

  while (pendingActionsExist && loopSafetyCounter < 100) {
    const pending = db.getPendingActions();

    if (pending.length === 0) {
      pendingActionsExist = false;
      break;
    }

    const actionToRun = pending[0];
    const payment = db.getFailedPayment(actionToRun.payment_id);
    
    if (payment) {
      await executeAction(payment, actionToRun, isFailureInjectionEnabled);
    } else {
      db.updateAction(actionToRun.action_id, {
        result: 'failure',
        error_message: 'Referenced payment record not found in database'
      });
    }
    
    loopSafetyCounter++;
  }

  // ── HOLDOUT: simulate control group self-recovery ────────────────────────
  let controlTotal = 0, controlRecovered = 0;
  let interventionTotal = 0, interventionRecovered = 0;

  const finalPayments = db.getFailedPayments();
  for (const p of finalPayments) {
    const classification = db.getClassification(p.payment_id);
    const rootCause = classification ? classification.root_cause : 'unknown';
    const isControl = controlGroupIds.has(p.payment_id);

    if (isControl) {
      controlTotal++;
      let selfRecoverProb = 0.05;
      if (rootCause === 'bank_timeout') selfRecoverProb = 0.40;
      if (rootCause === 'insufficient_funds') selfRecoverProb = 0.20;

      const selfRecovered = Math.random() < selfRecoverProb;
      if (selfRecovered) {
        controlRecovered++;
        db.updateFailedPaymentStatus(p.payment_id, 'recovered');
        db.addAuditLog(
          p.payment_id,
          'holdout',
          'Control Payment Self-Recovered',
          `Customer resolved issue without intervention (Simulated probability: ${(selfRecoverProb * 100).toFixed(0)}%).`
        );
      }
    } else {
      interventionTotal++;
      if (p.status === 'recovered') {
        interventionRecovered++;
      }
    }
  }

  // Compute holdout metrics
  const interventionRatePercent = interventionTotal > 0
    ? ((interventionRecovered / interventionTotal) * 100).toFixed(1)
    : '0.0';
  const controlRatePercent = controlTotal > 0
    ? ((controlRecovered / controlTotal) * 100).toFixed(1)
    : '0.0';
  const incrementalRecoveryPercent = (
    parseFloat(interventionRatePercent) - parseFloat(controlRatePercent)
  ).toFixed(1);

  // Persist holdout results for baseline-comparison endpoint
  lastBatchResults = {
    holdout: {
      interventionTotal,
      interventionRecovered,
      controlTotal,
      controlRecovered,
      interventionRatePercent,
      controlRatePercent,
      incrementalRecoveryPercent
    }
  };

  console.log(`📊 Holdout Results: Intervention ${interventionRatePercent}% vs Control ${controlRatePercent}% | Incremental: +${incrementalRecoveryPercent}%`);

  return {
    success: true,
    message: `Batch run executed successfully! Loop count: ${loopSafetyCounter}`,
    holdout: lastBatchResults.holdout
  };
}

app.post('/api/test/run-batch', async (req, res) => {
  try {
    const result = await executeBatchSimulation();
    res.json(result);
  } catch (err) {
    console.error('Error running synthetic batch:', err);
    res.status(500).json({ error: 'Failed to run synthetic batch.' });
  }
});

app.listen(PORT, async () => {
  console.log(`🚀 AI Revenue Recovery Agent Server running at http://localhost:${PORT}`);
  // If database only has test artifacts or is empty, auto-populate the 20 batch transactions
  if (db.getFailedPayments().length <= 1) {
    console.log('🔄 Auto-populating dashboard with 20 synthetic transactions...');
    try {
      await executeBatchSimulation();
      console.log('✅ Dashboard pre-populated with live batch simulation!');
    } catch (e) {
      console.warn('⚠️ Auto-population failed:', e.message);
    }
  }
});
export default app;
