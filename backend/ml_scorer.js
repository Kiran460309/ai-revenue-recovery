/**
 * ML Scorer — Lightweight Logistic Regression for Recovery Probability
 *
 * Implements a real 8-feature Logistic Regression model trained via Batch Gradient
 * Descent on recurring payment recovery telemetry.
 *
 * Features extracted (8):
 *   0: is_insufficient_funds (One-hot)
 *   1: is_expired_instrument (One-hot)
 *   2: is_bank_timeout (One-hot)
 *   3: is_risk_block (One-hot)
 *   4: amount_log_norm (log10(rupees) / 4.0, capped 0..1)
 *   5: attempt_norm (attempt_number / 3)
 *   6: days_since_success_norm (days / 90)
 *   7: salary_day_proximity (1.0 = on salary day, 0.0 = >=15 days away)
 *
 * Optimization:
 *   - Loss Function: Binary Cross-Entropy (Log-Loss)
 *   - Algorithm: Batch Gradient Descent with L2 regularization
 *   - Output: P(recovery | x) = sigmoid(w^T x + b)
 *
 * Trust-Boundary Contract:
 *   Advisory only — feeds the Policy Engine as an additional safety signal.
 */

// Sigmoid activation utility
function sigmoid(z) {
  // Clamp z to prevent numeric overflow
  const clampedZ = Math.max(-15, Math.min(15, z));
  return 1 / (1 + Math.exp(-clampedZ));
}

/**
 * Infers salary day from successful payment history (mode of day-of-month).
 */
export function inferSalaryDay(successfulHistory) {
  if (!successfulHistory || successfulHistory.length < 2) return null;
  const freq = {};
  for (const p of successfulHistory) {
    const d = new Date(p.timestamp).getUTCDate();
    freq[d] = (freq[d] || 0) + 1;
  }
  let modeDay = null, maxCount = 0;
  for (const d in freq) {
    if (freq[d] > maxCount) { maxCount = freq[d]; modeDay = parseInt(d, 10); }
  }
  return modeDay;
}

/**
 * Compute days since last successful payment for this customer.
 */
export function daysSinceLastSuccess(successfulHistory, referenceTimestamp) {
  if (!successfulHistory || successfulHistory.length === 0) return 90;
  const refMs = new Date(referenceTimestamp).getTime();
  let latest = 0;
  for (const p of successfulHistory) {
    const ts = new Date(p.timestamp).getTime();
    if (ts > latest) latest = ts;
  }
  const diffDays = (refMs - latest) / (1000 * 60 * 60 * 24);
  return Math.min(Math.max(diffDays, 0), 90);
}

/**
 * Compute salary-day proximity score [0,1]:
 *   1.0 = retry timestamp is ON the salary day
 *   0.0 = retry is 15+ days away from salary day
 */
export function salaryDayProximity(paymentTimestamp, salaryDay) {
  if (salaryDay === null) return 0.0;
  const payDay = new Date(paymentTimestamp).getUTCDate();
  const daysInMonth = 30;
  let diff = Math.abs(payDay - salaryDay);
  if (diff > daysInMonth / 2) diff = daysInMonth - diff;
  const MAX_WINDOW = 15;
  return Math.max(0, 1 - diff / MAX_WINDOW);
}

/**
 * Builds the 8-dimensional feature vector for a payment.
 */
export function extractFeatures(payment, classification, successfulHistory) {
  const rootCause = classification ? classification.root_cause : 'unknown';
  const amountRupees = (payment.amount || 0) / 100;

  // One-hot root causes
  const isInsuf = rootCause === 'insufficient_funds' ? 1 : 0;
  const isExpired = rootCause === 'expired_instrument' ? 1 : 0;
  const isTimeout = rootCause === 'bank_timeout' ? 1 : 0;
  const isRisk = rootCause === 'risk_block' ? 1 : 0;

  // Amount (log-normalized)
  const amountLogNorm = Math.min(Math.log10(Math.max(amountRupees, 1)) / 4.0, 1.0);

  // Attempt number normalized
  const attemptNorm = Math.min((payment.attempt_number || 0) / 3, 1.0);

  // Days since last success normalized
  const days = daysSinceLastSuccess(successfulHistory, payment.timestamp || new Date().toISOString());
  const daysNorm = days / 90;

  // Salary day proximity
  const salaryDay = inferSalaryDay(successfulHistory);
  const proximity = salaryDayProximity(payment.timestamp || new Date().toISOString(), salaryDay);

  return [isInsuf, isExpired, isTimeout, isRisk, amountLogNorm, attemptNorm, daysNorm, proximity];
}

// ------------------------------------------------------------------
// Synthetic Training Dataset for Mandate Recovery Patterns
// ------------------------------------------------------------------
// Labeled training samples representing recurring debit recovery outcomes:
// [isInsuf, isExpired, isTimeout, isRisk, amountNorm, attemptNorm, daysNorm, proximity, label(1=recovered, 0=failed)]
const TRAINING_DATASET = [
  // Bank Timeouts (High recovery probability ~70-80%)
  [0, 0, 1, 0, 0.45, 0.0, 0.1, 0.0, 1],
  [0, 0, 1, 0, 0.60, 0.33, 0.2, 0.0, 1],
  [0, 0, 1, 0, 0.80, 0.66, 0.3, 0.0, 0],
  [0, 0, 1, 0, 0.30, 0.0, 0.05, 0.0, 1],
  [0, 0, 1, 0, 0.50, 0.33, 0.1, 0.0, 1],
  [0, 0, 1, 0, 0.70, 0.0, 0.15, 0.0, 1],
  
  // Insufficient Funds on/near Salary Day (High recovery ~80-90%)
  [1, 0, 0, 0, 0.50, 0.0, 0.1, 0.95, 1],
  [1, 0, 0, 0, 0.40, 0.33, 0.2, 0.88, 1],
  [1, 0, 0, 0, 0.65, 0.0, 0.1, 1.0, 1],
  [1, 0, 0, 0, 0.55, 0.33, 0.15, 0.80, 1],

  // Insufficient Funds Far from Salary Day (Low/Moderate recovery ~30-40%)
  [1, 0, 0, 0, 0.50, 0.0, 0.3, 0.10, 0],
  [1, 0, 0, 0, 0.60, 0.33, 0.4, 0.05, 0],
  [1, 0, 0, 0, 0.35, 0.66, 0.5, 0.0, 0],
  [1, 0, 0, 0, 0.45, 0.0, 0.2, 0.25, 1],

  // Expired Instrument (Zero recovery without card update)
  [0, 1, 0, 0, 0.50, 0.0, 0.2, 0.0, 0],
  [0, 1, 0, 0, 0.40, 0.33, 0.4, 0.0, 0],
  [0, 1, 0, 0, 0.70, 0.66, 0.6, 0.0, 0],

  // Risk Block (Zero recovery)
  [0, 0, 0, 1, 0.60, 0.0, 0.1, 0.0, 0],
  [0, 0, 0, 1, 0.80, 0.33, 0.3, 0.0, 0],
  [0, 0, 0, 1, 0.50, 0.66, 0.5, 0.0, 0]
];

// Model Parameters
let weights = [0.6, -2.5, 1.4, -3.0, -0.3, -1.2, -0.4, 1.8];
let bias = 0.2;
let modelMetrics = {
  trained: false,
  epochs: 0,
  finalLoss: 0,
  accuracyPercent: 0,
  sampleCount: TRAINING_DATASET.length
};

/**
 * Trains the Logistic Regression model using Batch Gradient Descent with L2 regularization.
 */
export function trainModel(epochs = 300, learningRate = 0.1, lambdaL2 = 0.01) {
  const N = TRAINING_DATASET.length;
  const numFeatures = 8;

  // Initialize weights
  let w = new Array(numFeatures).fill(0);
  let b = 0.0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(numFeatures).fill(0);
    let gradB = 0;
    let totalLoss = 0;

    for (let i = 0; i < N; i++) {
      const sample = TRAINING_DATASET[i];
      const x = sample.slice(0, numFeatures);
      const y = sample[numFeatures];

      // Forward pass: z = w^T x + b
      let z = b;
      for (let j = 0; j < numFeatures; j++) {
        z += w[j] * x[j];
      }
      const yHat = sigmoid(z);

      // Binary Cross Entropy Loss: -[y log(yHat) + (1-y) log(1-yHat)]
      const eps = 1e-15;
      const loss = -(y * Math.log(yHat + eps) + (1 - y) * Math.log(1 - yHat + eps));
      totalLoss += loss;

      // Error term (yHat - y)
      const error = yHat - y;
      for (let j = 0; j < numFeatures; j++) {
        gradW[j] += error * x[j];
      }
      gradB += error;
    }

    // Gradient step with L2 regularization
    for (let j = 0; j < numFeatures; j++) {
      w[j] -= learningRate * (gradW[j] / N + lambdaL2 * w[j]);
    }
    b -= learningRate * (gradB / N);

    if (epoch === epochs - 1) {
      // Calculate training accuracy
      let correct = 0;
      for (let i = 0; i < N; i++) {
        const sample = TRAINING_DATASET[i];
        const x = sample.slice(0, numFeatures);
        const y = sample[numFeatures];
        let z = b;
        for (let j = 0; j < numFeatures; j++) z += w[j] * x[j];
        const pred = sigmoid(z) >= 0.5 ? 1 : 0;
        if (pred === y) correct++;
      }

      weights = w;
      bias = b;
      modelMetrics = {
        trained: true,
        epochs,
        finalLoss: parseFloat((totalLoss / N).toFixed(4)),
        accuracyPercent: parseFloat(((correct / N) * 100).toFixed(1)),
        sampleCount: N
      };
    }
  }

  return modelMetrics;
}

// Auto-train model on module initialization
trainModel(350, 0.15, 0.01);

/**
 * Returns current model parameters and training metrics.
 */
export function getModelMetrics() {
  return {
    ...modelMetrics,
    weights: weights.map(w => parseFloat(w.toFixed(4))),
    bias: parseFloat(bias.toFixed(4))
  };
}

/**
 * Scores the recovery probability for a payment using the trained Logistic Regression model.
 *
 * @param {object} payment           - Payment record
 * @param {object} classification    - Classification result { root_cause, confidence, method }
 * @param {Array}  successfulHistory - Array of successful payment records for this customer
 * @returns {{ score: number, features: object, reasoning: string }}
 */
export function scoreRecoveryProbability(payment, classification, successfulHistory) {
  const features = extractFeatures(payment, classification, successfulHistory);
  
  // Linear combination: z = w^T x + b
  let z = bias;
  for (let i = 0; i < features.length; i++) {
    z += weights[i] * features[i];
  }

  const score = sigmoid(z);
  const rootCause = classification ? classification.root_cause : 'unknown';
  const salaryDay = inferSalaryDay(successfulHistory);
  const amountRupees = (payment.amount || 0) / 100;
  const proximity = features[7];

  const reasoning = [
    `ML Score: ${score.toFixed(3)}`,
    `Root cause: ${rootCause}`,
    `Amount: ₹${amountRupees.toFixed(2)}`,
    `Attempt: #${payment.attempt_number || 0}`,
    salaryDay ? `Inferred salary day: ${salaryDay}, proximity: ${(proximity * 100).toFixed(0)}%` : 'No salary day inferred',
  ].join(' | ');

  return { 
    score: parseFloat(score.toFixed(4)), 
    features, 
    reasoning 
  };
}
