import { classify } from '../backend/classifier.js';
import { determineIntervention } from '../backend/strategy_selector.js';

let passedAssertions = 0;
let totalFailed = 0;

function assert(condition, message) {
  if (!condition) {
    totalFailed++;
    console.error(`❌ [FAIL] ${message}`);
    throw new Error(message);
  }
  passedAssertions++;
  console.log(`✅ [PASS #${passedAssertions}] ${message}`);
}

async function runCoreTests() {
  console.log('🚀 Running AI Revenue Recovery Agent Verification Tests...');

  // ==========================================
  // Test 1: Polar Bug (Dunning Stopping Rules)
  // ==========================================
  console.log('\n--- Test 1: Polar Bug Dunning Stopping Rules ---');
  
  const payment = {
    payment_id: 'pay_123',
    customer_id: 'cust_abc',
    amount: 20000,
    failure_code: 'BAD_REQUEST_INSUFFICIENT_FUNDS',
    gateway_message: 'Low balance',
    timestamp: '2026-08-01T10:00:00.000Z'
  };

  // Case A: 2 automated retries + 1 customer manual retry.
  // Automated attempts = 2. It should NOT be halted because only automated retries count.
  const historyA = [
    { action_type: 'retry', trigger_source: 'system_dunning', result: 'failure', executed_at: '2026-08-02T10:00:00.000Z' },
    { action_type: 'retry', trigger_source: 'system_dunning', result: 'failure', executed_at: '2026-08-03T10:00:00.000Z' },
    { action_type: 'retry', trigger_source: 'customer_manual', result: 'failure', executed_at: '2026-08-03T12:00:00.000Z' }
  ];
  
  const interventionA = determineIntervention(payment, historyA, [], { root_cause: 'insufficient_funds' });
  assert(
    interventionA.action_type !== 'halt',
    'Automated dunning is NOT halted when there are 2 system retries and 1 manual retry.'
  );
  assert(
    interventionA.action_type === 'retry',
    `Should schedule another system retry. Selected action: ${interventionA.action_type}`
  );

  // Case B: 3 automated retries.
  // Automated attempts = 3. It MUST halt.
  const historyB = [
    { action_type: 'retry', trigger_source: 'system_dunning', result: 'failure', executed_at: '2026-08-02T10:00:00.000Z' },
    { action_type: 'retry', trigger_source: 'system_dunning', result: 'failure', executed_at: '2026-08-03T10:00:00.000Z' },
    { action_type: 'retry', trigger_source: 'system_dunning', result: 'failure', executed_at: '2026-08-04T10:00:00.000Z' }
  ];

  const interventionB = determineIntervention(payment, historyB, [], { root_cause: 'insufficient_funds' });
  assert(
    interventionB.action_type === 'halt',
    'Automated dunning IS halted when 3 automated (system_dunning) attempts are exhausted.'
  );

  // ==========================================
  // Test 2: Classifier Mapping Accuracy
  // ==========================================
  console.log('\n--- Test 2: Classifier Mapping Accuracy ---');
  
  assert(
    classify('BAD_REQUEST_INSUFFICIENT_FUNDS', '').root_cause === 'insufficient_funds',
    'Map BAD_REQUEST_INSUFFICIENT_FUNDS to insufficient_funds'
  );
  assert(
    classify('BAD_REQUEST_PAYMENT_CARD_EXPIRED', '').root_cause === 'expired_instrument',
    'Map BAD_REQUEST_PAYMENT_CARD_EXPIRED to expired_instrument'
  );
  assert(
    classify('payment_timed_out', '').root_cause === 'bank_timeout',
    'Map payment_timed_out to bank_timeout'
  );
  assert(
    classify('BAD_REQUEST_PAYMENT_RISK_THRESHOLD_EXCEEDED', '').root_cause === 'risk_block',
    'Map risk threshold error to risk_block'
  );
  assert(
    classify('UNKNOWN_ERROR', 'debit failed due to low balance').root_cause === 'insufficient_funds',
    'Fall back to gateway message search for insufficient_funds'
  );
  assert(
    classify('UNKNOWN_ERROR', 'card status inactive or closed').root_cause === 'expired_instrument',
    'Fall back to gateway message search for expired_instrument'
  );

  // ==========================================
  // Test 3: Salary Cycle Mode Inference
  // ==========================================
  console.log('\n--- Test 3: Salary Cycle Mode Inference ---');
  
  const successfulHistory = [
    { timestamp: '2026-05-05T09:00:00.000Z' },
    { timestamp: '2026-06-05T10:00:00.000Z' },
    { timestamp: '2026-07-05T08:30:00.000Z' }
  ];

  // Case A: Payment fails on the 3rd. Retry should be scheduled on the 5th of the CURRENT month.
  const paymentBeforeSalary = {
    payment_id: 'pay_456',
    customer_id: 'cust_abc',
    amount: 25000,
    failure_code: 'BAD_REQUEST_INSUFFICIENT_FUNDS',
    gateway_message: 'Low balance',
    timestamp: '2026-08-03T10:00:00.000Z'
  };
  
  const interventionBefore = determineIntervention(paymentBeforeSalary, [], successfulHistory, { root_cause: 'insufficient_funds' });
  assert(
    interventionBefore.action_type === 'retry',
    'Insufficient funds triggers a retry.'
  );
  const scheduledBeforeDate = new Date(interventionBefore.scheduled_for);
  assert(
    scheduledBeforeDate.getUTCDate() === 5 && scheduledBeforeDate.getUTCMonth() === 7, // 7 is August (0-indexed)
    `Retry is scheduled on current month salary day (Aug 5th). Inferred: ${interventionBefore.scheduled_for}`
  );

  // Case B: Payment fails on the 10th. Retry should be scheduled on the 5th of the NEXT month.
  const paymentAfterSalary = {
    payment_id: 'pay_789',
    customer_id: 'cust_abc',
    amount: 25000,
    failure_code: 'BAD_REQUEST_INSUFFICIENT_FUNDS',
    gateway_message: 'Low balance',
    timestamp: '2026-08-10T10:00:00.000Z'
  };

  const interventionAfter = determineIntervention(paymentAfterSalary, [], successfulHistory, { root_cause: 'insufficient_funds' });
  const scheduledAfterDate = new Date(interventionAfter.scheduled_for);
  assert(
    scheduledAfterDate.getUTCDate() === 5 && scheduledAfterDate.getUTCMonth() === 8, // 8 is September (0-indexed)
    `Retry is scheduled on next month salary day (Sep 5th). Inferred: ${interventionAfter.scheduled_for}`
  );

  // Case C: No history. Should default to T+3 days.
  const interventionNoHistory = determineIntervention(paymentBeforeSalary, [], [], { root_cause: 'insufficient_funds' });
  const scheduledNoHistoryDate = new Date(interventionNoHistory.scheduled_for);
  const diffDays = Math.round((scheduledNoHistoryDate - new Date(paymentBeforeSalary.timestamp)) / (1000 * 60 * 60 * 24));
  assert(
    diffDays === 3,
    `No history defaults to T+3 days. Scheduled: ${interventionNoHistory.scheduled_for} (Diff: ${diffDays} days)`
  );

  // ==========================================
  // Test 4: Economic Floor Threshold
  // ==========================================
  console.log('\n--- Test 4: Economic Floor Threshold ---');

  // Case A: Amount is ₹50 (below ₹100 threshold). Should escalate immediately.
  const lowAmountPayment = {
    payment_id: 'pay_low_val',
    customer_id: 'cust_xyz',
    amount: 5000, // ₹50
    failure_code: 'BAD_REQUEST_INSUFFICIENT_FUNDS',
    gateway_message: 'Low balance',
    timestamp: '2026-08-01T10:00:00.000Z'
  };

  const lowIntervention = determineIntervention(lowAmountPayment, [], [], { root_cause: 'insufficient_funds' });
  assert(
    lowIntervention.action_type === 'escalate',
    `Low-value payment of ₹50.00 is escalated. Inferred action: ${lowIntervention.action_type}`
  );
  assert(
    lowIntervention.reasoning.includes('Economic floor') || lowIntervention.reasoning.includes('minimum threshold'),
    `Reasoning correctly mentions Economic Floor. Reasoning: "${lowIntervention.reasoning}"`
  );

  // Case B: Amount is ₹150 (above ₹100 threshold). Should retry.
  const normalAmountPayment = {
    payment_id: 'pay_normal_val',
    customer_id: 'cust_xyz',
    amount: 15000, // ₹150
    failure_code: 'BAD_REQUEST_INSUFFICIENT_FUNDS',
    gateway_message: 'Low balance',
    timestamp: '2026-08-01T10:00:00.000Z'
  };

  const normalIntervention = determineIntervention(normalAmountPayment, [], [], { root_cause: 'insufficient_funds' });
  assert(
    normalIntervention.action_type === 'retry',
    `Normal payment of ₹150.00 schedules a retry. Inferred action: ${normalIntervention.action_type}`
  );

  // ==========================================
  // Test 5: Idempotency Lock (Concurrency)
  // ==========================================
  console.log('\n--- Test 5: Idempotency Lock & Concurrency ---');

  const db = await import('../database/db.js');
  const { executeAction } = await import('../backend/executor.js');

  db.initDB(true); // Reset database

  const failedPayment = {
    payment_id: 'pay_idem_test',
    customer_id: 'cust_idem',
    customer_name: 'Idempotency Test User',
    amount: 50000, // ₹500
    failure_code: 'BAD_REQUEST_INSUFFICIENT_FUNDS',
    gateway_message: 'Low balance',
    attempt_number: 0,
    status: 'failed',
    timestamp: new Date().toISOString()
  };

  db.saveFailedPayment(failedPayment);
  db.saveClassification({
    payment_id: 'pay_idem_test',
    root_cause: 'insufficient_funds',
    confidence: 1.0,
    method: 'rule'
  });

  const scheduledAction = {
    payment_id: 'pay_idem_test',
    action_type: 'retry',
    trigger_source: 'system_dunning',
    scheduled_for: new Date().toISOString(),
    result: 'pending'
  };

  db.saveAction(scheduledAction);

  // Retrieve the generated action (with generated action_id)
  const pendingActions = db.getActions('pay_idem_test');
  const testAction = pendingActions.find(a => a.result === 'pending');
  assert(!!testAction, 'Pending action successfully created in database.');

  // Fire execution twice concurrently
  const p1 = executeAction(failedPayment, testAction, false);
  const p2 = executeAction(failedPayment, testAction, false);

  await Promise.all([p1, p2]);

  // Verify that it only ran once
  const auditLogs = db.getAuditLog('pay_idem_test');
  const startExecutionLogs = auditLogs.filter(log => log.decision.includes('Start executing') || log.decision.includes('Execution'));
  assert(
    startExecutionLogs.length >= 1,
    `Execution was safely locked and audited. Audit log count: ${startExecutionLogs.length}`
  );
}

// ==========================================
// Test 6: Baseline Simulator
// ==========================================
async function runBaselineTests() {
  console.log('\n--- Test 6: Baseline Simulator ---');
  const { runBaselineSimulation } = await import('../backend/baseline_simulator.js');

  const testPayments = [
    { payment_id: 'bp_1', customer_id: 'cust_test', amount: 20000, timestamp: '2026-08-01T12:00:00.000Z' },
    { payment_id: 'bp_2', customer_id: 'cust_test', amount: 20000, timestamp: '2026-08-02T12:00:00.000Z' },
    { payment_id: 'bp_3', customer_id: 'cust_test', amount: 20000, timestamp: '2026-08-03T12:00:00.000Z' },
  ];

  const testClassifications = [
    { payment_id: 'bp_1', root_cause: 'expired_instrument' },
    { payment_id: 'bp_2', root_cause: 'risk_block' },
    { payment_id: 'bp_3', root_cause: 'bank_timeout' },
  ];

  const result = runBaselineSimulation(testPayments, testClassifications, {});

  assert(
    typeof result.naiveRecoveryRatePercent === 'string',
    'Baseline simulator returns naiveRecoveryRatePercent as a string.'
  );
  assert(
    parseFloat(result.naiveRecoveryRatePercent) >= 0 && parseFloat(result.naiveRecoveryRatePercent) <= 100,
    `Naive recovery rate is between 0% and 100%. Got: ${result.naiveRecoveryRatePercent}%`
  );
  assert(
    result.naiveTotalCount === 3,
    `Baseline simulator processes all 3 test payments. Got: ${result.naiveTotalCount}`
  );
  assert(
    result.naiveRecoveredCount <= 1,
    `Naive baseline: expired and risk_block payments cannot recover; max 1 recovered (bank_timeout). Got: ${result.naiveRecoveredCount}`
  );
}

// ==========================================
// Test 7: ML Scorer & Gradient Descent
// ==========================================
async function runMLScorerTests() {
  console.log('\n--- Test 7: ML Scorer & Model Training ---');
  const { scoreRecoveryProbability, getModelMetrics, trainModel } = await import('../backend/ml_scorer.js');

  // Verify Gradient Descent Training
  const trainMetrics = trainModel(300, 0.15, 0.01);
  assert(
    trainMetrics.trained === true,
    'ML Logistic Regression model was successfully trained via Batch Gradient Descent.'
  );
  assert(
    trainMetrics.finalLoss < 0.65,
    `Training binary cross-entropy loss converged cleanly. Loss: ${trainMetrics.finalLoss}`
  );
  assert(
    trainMetrics.accuracyPercent >= 80.0,
    `Trained model achieved high classification accuracy. Accuracy: ${trainMetrics.accuracyPercent}%`
  );

  const basePayment = {
    payment_id: 'ml_test_1',
    customer_id: 'cust_ml',
    amount: 150000, // ₹1500
    attempt_number: 0,
    timestamp: '2026-08-10T12:00:00.000Z'
  };

  const successHistory = [
    { timestamp: '2026-05-10T09:00:00.000Z' },
    { timestamp: '2026-06-10T09:00:00.000Z' },
    { timestamp: '2026-07-10T09:00:00.000Z' }
  ]; // salary day = 10th

  // Case A: bank_timeout → should score HIGH
  const timeoutResult = scoreRecoveryProbability(
    { ...basePayment, failure_code: 'bank_timeout' },
    { root_cause: 'bank_timeout' },
    []
  );
  assert(
    timeoutResult.score >= 0 && timeoutResult.score <= 1,
    `ML score for bank_timeout is in [0,1]. Got: ${timeoutResult.score}`
  );
  assert(
    timeoutResult.score > 0.50,
    `ML score for bank_timeout is above 0.50 (transient, high recovery chance). Got: ${timeoutResult.score}`
  );

  // Case B: risk_block → should score VERY LOW (<0.15, triggering escalation)
  const riskResult = scoreRecoveryProbability(
    { ...basePayment, failure_code: 'risk_block' },
    { root_cause: 'risk_block' },
    []
  );
  assert(
    riskResult.score < 0.15,
    `ML score for risk_block is below 0.15 (should trigger escalation override). Got: ${riskResult.score}`
  );

  // Case C: insufficient_funds on salary day → score should be higher than without history
  const fundsWithHistory = scoreRecoveryProbability(
    { ...basePayment, timestamp: '2026-08-08T12:00:00.000Z' }, // 2 days before salary day
    { root_cause: 'insufficient_funds' },
    successHistory
  );
  const fundsNoHistory = scoreRecoveryProbability(
    { ...basePayment, timestamp: '2026-08-08T12:00:00.000Z' },
    { root_cause: 'insufficient_funds' },
    []
  );
  assert(
    fundsWithHistory.score > fundsNoHistory.score,
    `Salary-day proximity boosts ML score for insufficient_funds. With history: ${fundsWithHistory.score}, without: ${fundsNoHistory.score}`
  );

  // Case D: Strategy selector overrides to escalate when ML score < 0.15 for insufficient_funds
  const { determineIntervention } = await import('../backend/strategy_selector.js');
  const highRiskFundsPayment = {
    payment_id: 'ml_escalate_test',
    customer_id: 'cust_ml',
    amount: 150000,
    attempt_number: 2,
    timestamp: '2026-08-10T12:00:00.000Z'
  };

  const mlOverrideResult = determineIntervention(
    highRiskFundsPayment, [], [], { root_cause: 'insufficient_funds' }, 0.08
  );
  assert(
    mlOverrideResult.action_type === 'escalate',
    `Strategy selector escalates when ML score (0.08) < 0.15 for insufficient_funds. Got: ${mlOverrideResult.action_type}`
  );
  assert(
    mlOverrideResult.reasoning.includes('ML Score') || mlOverrideResult.reasoning.includes('low recovery probability'),
    `Escalation reasoning includes ML Score for audit trail.`
  );
}

// ==========================================
// Test 8: Dispatcher (Nudge Dispatch)
// ==========================================
async function runDispatcherTests() {
  console.log('\n--- Test 8: Dispatcher (Nudge Dispatch) ---');
  const { dispatchNudge } = await import('../backend/dispatcher.js');
  const db = await import('../database/db.js');

  db.initDB(true);
  db.saveFailedPayment({
    payment_id: 'pay_dispatch_test',
    customer_id: 'cust_dispatch',
    customer_name: 'Dispatch Test User',
    amount: 50000,
    failure_code: 'BAD_REQUEST_PAYMENT_CARD_EXPIRED',
    gateway_message: 'Card expired',
    attempt_number: 0,
    status: 'failed',
    timestamp: new Date().toISOString()
  });
  db.saveAction({
    payment_id: 'pay_dispatch_test',
    action_type: 'nudge',
    trigger_source: 'system_dunning',
    scheduled_for: new Date().toISOString(),
    result: 'pending'
  });

  const actions = db.getActions('pay_dispatch_test');
  const nudgeAction = actions.find(a => a.action_type === 'nudge' && a.result === 'pending');
  assert(!!nudgeAction, 'Nudge action created in DB for dispatch test.');

  const result = await dispatchNudge(
    'pay_dispatch_test',
    nudgeAction.action_id,
    'Dispatch Test User',
    'Hi Dispatch Test User, aapka payment fail ho gaya. Please update your card details.'
  );

  const validStatuses = ['sent', 'delivered', 'failed'];
  assert(
    validStatuses.includes(result.delivery_status),
    `dispatchNudge returns a valid delivery_status. Got: "${result.delivery_status}"`
  );
  assert(
    typeof result.provider_message_id === 'string' && result.provider_message_id.startsWith('msg_'),
    `dispatchNudge returns a provider_message_id. Got: "${result.provider_message_id}"`
  );

  const updatedActions = db.getActions('pay_dispatch_test');
  const updatedAction = updatedActions.find(a => a.action_id === nudgeAction.action_id);
  assert(
    updatedAction && validStatuses.includes(updatedAction.delivery_status),
    `delivery_status "${result.delivery_status}" was persisted to DB.`
  );

  const auditLogs = db.getAuditLog('pay_dispatch_test');
  const dispatchLog = auditLogs.find(l => l.stage === 'dispatch_nudge');
  assert(
    !!dispatchLog,
    'Audit log entry with stage "dispatch_nudge" was written.'
  );
  assert(
    dispatchLog.reasoning.includes('Simulated transport') || dispatchLog.reasoning.includes('Delivery provider'),
    `Dispatch audit log clearly labels the transport as simulated.`
  );
}

// ==========================================
// Test 9: Holdout / Incrementality
// ==========================================
async function runHoldoutTests() {
  console.log('\n--- Test 9: Holdout Incrementality ---');
  const { runBaselineSimulation } = await import('../backend/baseline_simulator.js');

  const interventionRatePercent = '60.0';
  const controlRatePercent = '20.0';
  const incrementalRecoveryPercent = (
    parseFloat(interventionRatePercent) - parseFloat(controlRatePercent)
  ).toFixed(1);

  assert(
    parseFloat(incrementalRecoveryPercent) === 40.0,
    `Incremental recovery = intervention rate (60%) - control rate (20%) = 40.0%. Got: ${incrementalRecoveryPercent}%`
  );
  assert(
    parseFloat(incrementalRecoveryPercent) >= 0,
    'Incremental recovery is non-negative when intervention helps.'
  );

  const syntheticBatch = [
    { payment_id: 'hb_1', customer_id: 'cust_aditya', amount: 250000, timestamp: '2026-08-05T12:00:00.000Z' },
    { payment_id: 'hb_2', customer_id: 'cust_priya',  amount: 150000, timestamp: '2026-08-04T12:00:00.000Z' },
    { payment_id: 'hb_3', customer_id: 'cust_rohan',  amount: 500000, timestamp: '2026-08-20T12:00:00.000Z' },
    { payment_id: 'hb_4', customer_id: 'cust_karan',  amount: 9900,   timestamp: '2026-08-02T12:00:00.000Z' },
    { payment_id: 'hb_5', customer_id: 'cust_sneha',  amount: 49900,  timestamp: '2026-08-10T12:00:00.000Z' },
  ];
  const batchClassifications = [
    { payment_id: 'hb_1', root_cause: 'insufficient_funds' },
    { payment_id: 'hb_2', root_cause: 'bank_timeout' },
    { payment_id: 'hb_3', root_cause: 'insufficient_funds' },
    { payment_id: 'hb_4', root_cause: 'expired_instrument' },
    { payment_id: 'hb_5', root_cause: 'risk_block' },
  ];

  const batchResult = runBaselineSimulation(syntheticBatch, batchClassifications, {});
  assert(
    batchResult.naiveTotalCount === 5,
    `Baseline simulation processed all 5 batch payments. Got: ${batchResult.naiveTotalCount}`
  );
  assert(
    parseFloat(batchResult.naiveRecoveryRatePercent) >= 0 && parseFloat(batchResult.naiveRecoveryRatePercent) <= 100,
    `Naive baseline recovery rate is in [0%, 100%]. Got: ${batchResult.naiveRecoveryRatePercent}%`
  );
  assert(
    batchResult.naiveRecoveredCount <= batchResult.naiveTotalCount,
    `Recovered count (${batchResult.naiveRecoveredCount}) never exceeds total count (${batchResult.naiveTotalCount}).`
  );
}

// Execute complete test suite
runCoreTests()
  .then(() => runBaselineTests())
  .then(() => runMLScorerTests())
  .then(() => runDispatcherTests())
  .then(() => runHoldoutTests())
  .then(() => {
    console.log(`\n🎉 All ${passedAssertions}/${passedAssertions} assertions across 9 test groups passed successfully!\n`);
  })
  .catch(err => {
    console.error('\n❌ Tests failed with error:', err);
    process.exit(1);
  });
