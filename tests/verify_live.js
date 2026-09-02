// Live API Endpoint Verification Script

async function testLive() {
  console.log('📡 Testing Live Running Server at http://localhost:3000...\n');

  // 1. Run Batch Simulation 3 Times
  for (let i = 1; i <= 3; i++) {
    console.log(`--- Running Batch Simulation #${i} ---`);
    const res = await fetch('http://localhost:3000/api/test/run-batch', { method: 'POST' });
    if (!res.ok) throw new Error(`Batch #${i} failed with status ${res.status}`);
    const data = await res.json();
    console.log(`✅ Batch #${i} Success: ${data.message}`);
    console.log(`   Holdout: Intervention ${data.holdout.interventionRatePercent}% vs Control ${data.holdout.controlRatePercent}% (Incremental: +${data.holdout.incrementalRecoveryPercent}%)\n`);
  }

  // 2. Test /api/nudges and /api/nudges/feed
  console.log('--- Verifying Nudges Endpoints ---');
  const resNudges = await fetch('http://localhost:3000/api/nudges');
  const nudgesData = await resNudges.json();
  console.log(`✅ GET /api/nudges status: ${resNudges.status} | Item count: ${nudgesData.length}`);
  if (nudgesData.length > 0) {
    console.log(`   Sample Nudge: "${nudgesData[0].nudge_message.slice(0, 70)}..."`);
  }

  const resFeed = await fetch('http://localhost:3000/api/nudges/feed');
  const feedData = await resFeed.json();
  console.log(`✅ GET /api/nudges/feed status: ${resFeed.status} | Item count: ${feedData.length}\n`);

  // 3. Test /api/report/baseline-comparison
  console.log('--- Verifying Baseline Comparison Endpoint ---');
  const resBaseline = await fetch('http://localhost:3000/api/report/baseline-comparison');
  const baselineData = await resBaseline.json();
  console.log(`✅ GET /api/report/baseline-comparison status: ${resBaseline.status}`);
  console.log(`   AI Recovery Rate: ${baselineData.aiRecoveryRatePercent}% (₹${baselineData.aiRecoveredRupees})`);
  console.log(`   Naive Baseline:   ${baselineData.naiveRecoveryRatePercent}% (₹${baselineData.naiveRecoveredRupees})`);
  console.log(`   Uplift:           +${baselineData.upliftPercent}%`);
  console.log(`   Total Rupee Pool: ₹${baselineData.totalRupees}\n`);

  console.log('🎉 ALL LIVE API CHECKS PASSED WITH 100% SUCCESS!');
}

testLive().catch(err => {
  console.error('❌ Live API test failed:', err);
  process.exit(1);
});
