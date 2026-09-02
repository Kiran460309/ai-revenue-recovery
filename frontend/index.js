const API_BASE = '/api';
let recoveryChart = null;

// DOM Elements
const totalAtRiskEl = document.getElementById('total-at-risk');
const totalFailedCountEl = document.getElementById('total-failed-count');
const totalRecoveredEl = document.getElementById('total-recovered');
const totalRecoveredCountEl = document.getElementById('total-recovered-count');
const recoveryRateEl = document.getElementById('recovery-rate');
const recoveryProgressEl = document.getElementById('recovery-progress');
const falseStopRateEl = document.getElementById('false-stop-rate');
const haltedMandatesCountEl = document.getElementById('halted-mandates-count');

const timeoutToggle = document.getElementById('timeout-toggle');
const runBatchBtn = document.getElementById('run-batch-btn');
const transactionRows = document.getElementById('transaction-rows');
const quickAuditStream = document.getElementById('quick-audit-stream');
const activeBadge = document.getElementById('active-badge');

// Baseline + Holdout stat card elements
const baselineUpliftEl = document.getElementById('baseline-uplift');
const baselineSubEl = document.getElementById('baseline-sub');
const incrementalRecoveryEl = document.getElementById('incremental-recovery');
const incrementalSubEl = document.getElementById('incremental-sub');

// Nudges feed elements
const nudgesFeed = document.getElementById('nudges-feed');
const nudgesBadge = document.getElementById('nudges-badge');

// Modal Elements
const auditModal = document.getElementById('audit-modal');
const closeModalBtn = document.getElementById('close-modal-btn');
const modalTitle = document.getElementById('modal-title');
const modalSubtitle = document.getElementById('modal-subtitle');
const summaryCustomerId = document.getElementById('summary-customer-id');
const summaryAmount = document.getElementById('summary-amount');
const summaryStatus = document.getElementById('summary-status');
const classCause = document.getElementById('class-cause');
const classConfidence = document.getElementById('class-confidence');
const classMethod = document.getElementById('class-method');
const timelineList = document.getElementById('timeline-list');

// Initialize the dashboard
document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();

  // Setup Event Listeners
  runBatchBtn.addEventListener('click', handleRunBatch);
  timeoutToggle.addEventListener('change', handleToggleTimeout);
  closeModalBtn.addEventListener('click', () => auditModal.classList.remove('active'));
  
  // Close modal when clicking outside content
  window.addEventListener('click', (e) => {
    if (e.target === auditModal) {
      auditModal.classList.remove('active');
    }
  });
});

/**
 * Loads the dashboard data: metrics, charts, tables, and audit logs
 */
async function loadDashboard() {
  try {
    const res = await fetch(`${API_BASE}/report/recovery-rate`);
    if (!res.ok) throw new Error('Failed to fetch recovery statistics');
    const data = await res.json();

    updateMetrics(data);
    updateChart(data.breakdown);
    updateTransactionTable(data.payments);
    await loadAuditStream();
    await loadBaselineComparison();
    await loadNudgeFeed();
  } catch (err) {
    console.error('Error loading dashboard:', err);
  }
}

/**
 * Updates the text metrics cards
 */
function updateMetrics(data) {
  const o = data.overall;
  totalAtRiskEl.textContent = `₹${parseFloat(o.totalAtRiskRupees).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  totalFailedCountEl.textContent = `${o.totalCount} Failed Payments`;
  
  totalRecoveredEl.textContent = `₹${parseFloat(o.totalRecoveredRupees).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  
  const recoveredCount = data.payments.filter(p => p.status === 'recovered').length;
  totalRecoveredCountEl.textContent = `${recoveredCount} Successful Retries`;

  recoveryRateEl.textContent = `${o.recoveryRatePercent}%`;
  recoveryProgressEl.style.width = `${o.recoveryRatePercent}%`;

  falseStopRateEl.textContent = `${o.falseStopRatePercent}%`;
  haltedMandatesCountEl.textContent = `${o.haltedCount} Mandates Stopped`;
  
  const activeCount = data.payments.filter(p => p.status === 'failed' || p.status === 'recovering').length;
  activeBadge.textContent = `${activeCount} active`;
}

/**
 * Updates or creates the Chart.js visual statistics
 */
function updateChart(breakdown) {
  // Map root causes in order
  const rootCauses = ['insufficient_funds', 'expired_instrument', 'bank_timeout', 'risk_block', 'unknown'];
  const labels = ['Insufficient Funds', 'Expired Card', 'Bank Timeout', 'Risk Block', 'Unknown'];
  const rates = rootCauses.map(cause => {
    const item = breakdown.find(b => b.root_cause === cause);
    return item ? parseFloat(item.recoveryRatePercent) : 0.0;
  });

  if (recoveryChart) {
    recoveryChart.data.datasets[0].data = rates;
    recoveryChart.update();
  } else {
    const ctx = document.getElementById('recovery-chart').getContext('2d');
    recoveryChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          data: rates,
          backgroundColor: [
            '#3b82f6', // blue
            '#ef4444', // red
            '#10b981', // green
            '#f97316', // orange
            '#94a3b8'  // grey
          ],
          borderRadius: 6,
          barThickness: 24
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function(context) {
                return `Recovery Rate: ${context.raw}%`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: '#94a3b8', font: { family: 'Inter', size: 11 } }
          },
          y: {
            min: 0,
            max: 100,
            grid: { color: '#33415550' },
            ticks: { color: '#94a3b8', font: { family: 'Inter', size: 11 }, callback: v => v + '%' }
          }
        }
      }
    });
  }
}

/**
 * Populates the transaction grid
 */
function updateTransactionTable(payments) {
  transactionRows.innerHTML = '';
  
  if (!payments || payments.length === 0) {
    transactionRows.innerHTML = `
      <tr>
        <td colspan="7" class="text-center text-muted">No transactions loaded. Click "Run Batch Simulation" above to ingest synthetic payments.</td>
      </tr>
    `;
    return;
  }

  payments.forEach(p => {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.addEventListener('click', () => showAuditTrail(p.payment_id));

    // Formatted cause
    const causeLabel = p.root_cause.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    
    // Status pill
    const statusPill = `<span class="status-pill ${p.status}">${p.status}</span>`;

    // Action button if manually retriable
    let actionBtn = '';
    if (p.status === 'failed' || p.status === 'escalated') {
      actionBtn = `<button class="btn btn-secondary manual-retry-btn" data-id="${p.payment_id}">Manual Retry</button>`;
    }

    tr.innerHTML = `
      <td class="text-bold">${p.payment_id}</td>
      <td>${p.customer_name || p.customer_id}</td>
      <td>₹${(p.amount / 100).toFixed(2)}</td>
      <td>${causeLabel}</td>
      <td class="text-center">${p.attempt_number}</td>
      <td>${statusPill}</td>
      <td>${actionBtn}</td>
    `;

    // Hook manual retry action
    const btn = tr.querySelector('.manual-retry-btn');
    if (btn) {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation(); // Prevent row click opening modal
        btn.disabled = true;
        btn.textContent = 'Retrying...';
        await handleManualRetry(p.payment_id);
      });
    }

    transactionRows.appendChild(tr);
  });
}

/**
 * Loads and displays the recent global audit log stream
 */
async function loadAuditStream() {
  try {
    const res = await fetch(`${API_BASE}/audit-logs`);
    if (!res.ok) throw new Error('Failed to fetch audit logs');
    const logs = await res.json();

    quickAuditStream.innerHTML = '';

    if (!logs || logs.length === 0) {
      quickAuditStream.innerHTML = '<p class="text-muted">No audit events generated yet.</p>';
      return;
    }

    logs.forEach(l => {
      const timeStr = new Date(l.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const item = document.createElement('div');
      item.className = 'audit-item';
      item.innerHTML = `
        <div class="audit-item-header">
          <strong>${l.payment_id} — ${l.stage.toUpperCase()}</strong>
          <span>${timeStr}</span>
        </div>
        <div class="audit-item-detail"><strong>${l.decision}</strong>: ${l.reasoning}</div>
      `;
      quickAuditStream.appendChild(item);
    });
  } catch (err) {
    console.error('Error loading audit stream:', err);
  }
}

/**
 * Triggers full batch processing simulation
 */
async function handleRunBatch() {
  runBatchBtn.disabled = true;
  runBatchBtn.textContent = 'Processing Batch...';
  
  try {
    const res = await fetch(`${API_BASE}/test/run-batch`, { method: 'POST' });
    if (!res.ok) throw new Error('Batch simulation failed');
    await loadDashboard();
  } catch (err) {
    alert('Failed to execute batch: ' + err.message);
  } finally {
    runBatchBtn.disabled = false;
    runBatchBtn.textContent = 'Run Batch Simulation';
  }
}

/**
 * Handles API timeout injection switch state change
 */
async function handleToggleTimeout() {
  const isEnabled = timeoutToggle.checked;
  try {
    await fetch(`${API_BASE}/test/inject-failure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: isEnabled })
    });
  } catch (err) {
    console.error('Failed to toggle failure injection:', err);
  }
}

/**
 * Handles customer-initiated manual retry triggering
 */
async function handleManualRetry(paymentId) {
  try {
    const res = await fetch(`${API_BASE}/payments/${paymentId}/manual-retry`, { method: 'POST' });
    const data = await res.json();
    
    if (data.success) {
      alert(`Success! Payment ${paymentId} recovered via manual retry.`);
    } else {
      alert(`Payment retry for ${paymentId} failed. Status: ${data.status}. Decline reason was logged.`);
    }
    await loadDashboard();
  } catch (err) {
    alert('Error running manual retry: ' + err.message);
    await loadDashboard();
  }
}

/**
 * Fetches and displays detailed audit logs for a single transaction in a modal
 */
async function showAuditTrail(paymentId) {
  try {
    const res = await fetch(`${API_BASE}/payments/${paymentId}/audit-trail`);
    if (!res.ok) throw new Error('Failed to fetch payment details');
    const data = await res.json();

    const p = data.payment;
    const c = data.classification;
    const actions = data.actions;
    const logs = data.auditLogs;

    // Set header
    modalTitle.textContent = `Payment Audit: ${p.payment_id}`;
    modalSubtitle.textContent = `Customer: ${p.customer_name || p.customer_id} | Ingested: ${new Date(p.timestamp).toLocaleString()}`;

    // Set summary
    summaryCustomerId.textContent = p.customer_id;
    summaryAmount.textContent = `₹${(p.amount / 100).toFixed(2)}`;
    
    summaryStatus.textContent = p.status;
    summaryStatus.className = `status-pill ${p.status}`;

    // Set classification
    if (c) {
      const causeLabel = c.root_cause.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
      classCause.textContent = causeLabel;
      classConfidence.textContent = `${(c.confidence * 100).toFixed(0)}%`;
      classMethod.textContent = c.method === 'llm_fallback' ? 'Gemini AI Fallback' : 'Static Rule';
      classMethod.style.backgroundColor = c.method === 'llm_fallback' ? '#8b5cf630' : '#47556950';
      classMethod.style.color = c.method === 'llm_fallback' ? '#a78bfa' : '#94a3b8';
    } else {
      classCause.textContent = 'Not Classified';
      classConfidence.textContent = '-';
      classMethod.textContent = 'None';
    }

    // Set timeline list
    timelineList.innerHTML = '';
    
    // Sort logs chronologically
    logs.forEach(l => {
      const li = document.createElement('li');
      
      // Determine dot color class based on stage / details
      let itemClass = 'pending';
      if (l.stage === 'ingest') itemClass = 'pending';
      else if (l.stage === 'classify') itemClass = 'pending';
      else if (l.stage === 'select_strategy') {
        if (l.decision.includes('Halt')) itemClass = 'failure';
        else itemClass = 'pending';
      } else if (l.stage === 'execute') {
        if (l.decision.includes('Succeeded') || l.decision.includes('Nudge Sent')) itemClass = 'success';
        else if (l.decision.includes('Failed') || l.decision.includes('Timeout') || l.decision.includes('Error')) itemClass = 'failure';
        else itemClass = 'pending';
      }

      li.className = `timeline-item ${itemClass}`;
      
      const timeStr = new Date(l.timestamp).toLocaleString();
      li.innerHTML = `
        <div class="timeline-date">${timeStr}</div>
        <div class="timeline-title">${l.stage.toUpperCase()}: ${l.decision}</div>
        <div class="timeline-desc">${l.reasoning}</div>
      `;
      timelineList.appendChild(li);
    });

    auditModal.classList.add('active');
  } catch (err) {
    alert('Error loading audit modal: ' + err.message);
  }
}

/**
 * Fetches and displays the baseline comparison stat card
 */
async function loadBaselineComparison() {
  try {
    const res = await fetch(`${API_BASE}/report/baseline-comparison`);
    if (!res.ok) throw new Error('Failed to fetch baseline comparison');
    const data = await res.json();

    const uplift = parseFloat(data.upliftPercent);
    const sign = uplift >= 0 ? '+' : '';
    baselineUpliftEl.textContent = `${sign}${data.upliftPercent}%`;
    baselineUpliftEl.className = `stat-value ${uplift >= 0 ? 'text-green' : 'text-red'}`;
    baselineSubEl.textContent = `AI: ${data.aiRecoveryRatePercent}% vs Naive: ${data.naiveRecoveryRatePercent}%`;

    // Holdout incremental recovery (Step 4)
    if (data.holdout) {
      const inc = parseFloat(data.holdout.incrementalRecoveryPercent);
      const iSign = inc >= 0 ? '+' : '';
      incrementalRecoveryEl.textContent = `${iSign}${data.holdout.incrementalRecoveryPercent}%`;
      incrementalRecoveryEl.className = `stat-value ${inc >= 0 ? 'text-purple' : 'text-red'}`;
      incrementalSubEl.textContent = `Intervention ${data.holdout.interventionRatePercent}% vs Control ${data.holdout.controlRatePercent}%`;
    }
  } catch (err) {
    console.warn('Baseline comparison not available:', err.message);
  }
}

/**
 * Loads and renders the Delivered Nudges Feed
 */
async function loadNudgeFeed() {
  try {
    const res = await fetch(`${API_BASE}/nudges/feed`);
    if (!res.ok) throw new Error('Failed to fetch nudges feed');
    const nudges = await res.json();

    nudgesBadge.textContent = `${nudges.length} nudge${nudges.length !== 1 ? 's' : ''}`;
    nudgesFeed.innerHTML = '';

    if (!nudges || nudges.length === 0) {
      nudgesFeed.innerHTML = '<p class="text-muted">No nudges dispatched yet. Run a batch simulation to generate nudge events.</p>';
      return;
    }

    nudges.forEach(n => {
      const deliveryStatus = n.delivery_status || 'pending';
      const statusIcons = { sent: '📤', delivered: '✅', failed: '❌', pending: '⏳' };
      const timeStr = n.executed_at
        ? new Date(n.executed_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '—';

      const card = document.createElement('div');
      card.className = 'nudge-card';
      card.innerHTML = `
        <div class="nudge-card-header">
          <span class="nudge-card-id">${n.payment_id}</span>
          <span class="nudge-card-time">${timeStr}</span>
        </div>
        <div class="nudge-card-message">"${n.nudge_message || '—'}"</div>
        <span class="nudge-delivery-badge ${deliveryStatus}">
          ${statusIcons[deliveryStatus] || ''} ${deliveryStatus}
        </span>
      `;
      nudgesFeed.appendChild(card);
    });
  } catch (err) {
    console.warn('Nudge feed not available:', err.message);
  }
}
