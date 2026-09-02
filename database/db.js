import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DB_PATH = path.resolve(__dirname, 'db.json');

// Initialize database template
const DEFAULT_DB = {
  failed_payments: [],
  successful_payments: [],
  classifications: [],
  actions: [],
  audit_log: []
};

// Seed customer payment histories to test salary-cycle mode inference.
// Each customer has 3 historical successful payments, setting their salary day.
const SEED_SUCCESSFUL_PAYMENTS = [
  // Aditya - Salary Day = 1st of the month
  { payment_id: 'pay_hist_1', customer_id: 'cust_aditya', amount: 250000, timestamp: '2026-05-01T09:00:00.000Z' },
  { payment_id: 'pay_hist_2', customer_id: 'cust_aditya', amount: 250000, timestamp: '2026-06-01T09:15:00.000Z' },
  { payment_id: 'pay_hist_3', customer_id: 'cust_aditya', amount: 250000, timestamp: '2026-07-01T08:45:00.000Z' },

  // Priya - Salary Day = 7th of the month
  { payment_id: 'pay_hist_4', customer_id: 'cust_priya', amount: 150000, timestamp: '2026-05-07T10:00:00.000Z' },
  { payment_id: 'pay_hist_5', customer_id: 'cust_priya', amount: 150000, timestamp: '2026-06-07T10:30:00.000Z' },
  { payment_id: 'pay_hist_6', customer_id: 'cust_priya', amount: 150000, timestamp: '2026-07-07T09:45:00.000Z' },

  // Rohan - Salary Day = 28th of the month
  { payment_id: 'pay_hist_7', customer_id: 'cust_rohan', amount: 500000, timestamp: '2026-05-28T18:00:00.000Z' },
  { payment_id: 'pay_hist_8', customer_id: 'cust_rohan', amount: 500000, timestamp: '2026-06-28T18:20:00.000Z' },
  { payment_id: 'pay_hist_9', customer_id: 'cust_rohan', amount: 500000, timestamp: '2026-07-28T17:45:00.000Z' },

  // Karan - Salary Day = 10th of the month
  { payment_id: 'pay_hist_10', customer_id: 'cust_karan', amount: 9900, timestamp: '2026-05-10T11:00:00.000Z' },
  { payment_id: 'pay_hist_11', customer_id: 'cust_karan', amount: 9900, timestamp: '2026-06-10T11:15:00.000Z' },
  { payment_id: 'pay_hist_12', customer_id: 'cust_karan', amount: 9900, timestamp: '2026-07-10T10:50:00.000Z' }
  
  // Note: Sneha (cust_sneha) has no seed successful payments to test the T+3 fallback rule.
];

export function initDB(forceReset = false) {
  // Ensure the database folder exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (forceReset || !fs.existsSync(DB_PATH)) {
    const db = { ...DEFAULT_DB, successful_payments: SEED_SUCCESSFUL_PAYMENTS };
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
    console.log('📦 Database initialized and seeded with historical successful payments.');
  }
}

// Read database contents synchronously
function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    initDB();
  }
  try {
    const data = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading database file, returning default:', err);
    return DEFAULT_DB;
  }
}

// Write database contents synchronously
function writeDB(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing to database file:', err);
  }
}

// Failed Payments Operations
export function saveFailedPayment(payment) {
  const db = readDB();
  // Avoid duplicate ingestion
  const exists = db.failed_payments.some(p => p.payment_id === payment.payment_id);
  if (!exists) {
    db.failed_payments.push({
      payment_id: payment.payment_id,
      customer_id: payment.customer_id,
      customer_name: payment.customer_name || payment.customer_id,
      amount: payment.amount,
      failure_code: payment.failure_code,
      gateway_message: payment.gateway_message || '',
      attempt_number: payment.attempt_number || 0,
      status: payment.status || 'failed', // failed, recovering, recovered, halted, escalated
      timestamp: payment.timestamp || new Date().toISOString()
    });
    writeDB(db);
  }
}

export function updateFailedPaymentStatus(paymentId, status, attemptNumber = null) {
  const db = readDB();
  const payment = db.failed_payments.find(p => p.payment_id === paymentId);
  if (payment) {
    payment.status = status;
    if (attemptNumber !== null) {
      payment.attempt_number = attemptNumber;
    }
    writeDB(db);
  }
}

export function getFailedPayments() {
  return readDB().failed_payments;
}

export function getFailedPayment(paymentId) {
  return readDB().failed_payments.find(p => p.payment_id === paymentId);
}

// Classifications Operations
export function saveClassification(classification) {
  const db = readDB();
  // Upsert classification
  const index = db.classifications.findIndex(c => c.payment_id === classification.payment_id);
  const data = {
    payment_id: classification.payment_id,
    root_cause: classification.root_cause,
    confidence: classification.confidence,
    method: classification.method // rule | llm_fallback
  };
  if (index !== -1) {
    db.classifications[index] = data;
  } else {
    db.classifications.push(data);
  }
  writeDB(db);
}

export function getClassification(paymentId) {
  return readDB().classifications.find(c => c.payment_id === paymentId);
}

// Actions Operations
export function saveAction(action) {
  const db = readDB();
  db.actions.push({
    action_id: `act_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    payment_id: action.payment_id,
    action_type: action.action_type, // retry | nudge | escalate | halt
    trigger_source: action.trigger_source, // system_dunning | customer_manual
    scheduled_for: action.scheduled_for || new Date().toISOString(),
    executed_at: action.executed_at || null,
    result: action.result || 'pending', // success | failure | pending | timeout
    error_message: action.error_message || null,
    nudge_message: action.nudge_message || null,
    delivery_status: action.delivery_status || null // sent | delivered | failed (Step 3)
  });
  writeDB(db);
}

export function getActions(paymentId) {
  return readDB().actions.filter(a => a.payment_id === paymentId);
}

export function getAllActions() {
  return readDB().actions;
}

export function getPendingActions() {
  return readDB().actions.filter(a => a.result === 'pending');
}

export function getRawState() {
  return readDB();
}

export function updateAction(actionId, updates) {
  const db = readDB();
  const action = db.actions.find(a => a.action_id === actionId);
  if (action) {
    Object.assign(action, updates);
    writeDB(db);
  }
}

// Audit Log Operations
export function addAuditLog(paymentId, stage, decision, reasoning) {
  const db = readDB();
  db.audit_log.push({
    event_id: `evt_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    payment_id: paymentId,
    stage, // ingest | classify | select_strategy | execute
    decision,
    reasoning,
    timestamp: new Date().toISOString()
  });
  writeDB(db);
}

export function getAuditLog(paymentId) {
  return readDB().audit_log.filter(l => l.payment_id === paymentId)
                          .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

export function getAllAuditLogs() {
  return readDB().audit_log;
}

// Successful Payments Operations (History)
export function getSuccessfulPayments(customerId) {
  return readDB().successful_payments.filter(p => p.customer_id === customerId);
}
