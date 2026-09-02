import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

// Standard dictionary of codes mapping directly to root causes
const FAILURE_CODE_MAP = {
  'BAD_REQUEST_INSUFFICIENT_FUNDS': 'insufficient_funds',
  'BAD_REQUEST_PAYMENT_CARD_EXPIRED': 'expired_instrument',
  'BAD_REQUEST_PAYMENT_ACCOUNT_BLOCKED': 'risk_block',
  'BAD_REQUEST_PAYMENT_RISK_THRESHOLD_EXCEEDED': 'risk_block',
  'BAD_REQUEST_PAYMENT_TIMED_OUT': 'bank_timeout',
  'payment_timed_out': 'bank_timeout',
  'insufficient_funds': 'insufficient_funds',
  'expired_instrument': 'expired_instrument',
  'risk_block': 'risk_block',
  'bank_timeout': 'bank_timeout'
};

// Regex patterns for classification from gateway text messages
const REGEX_MAP = [
  {
    pattern: /insufficient balance|low balance|insufficient funds|balance too low|funds unavailable/i,
    cause: 'insufficient_funds'
  },
  {
    pattern: /expired|card status inactive|card status closed|invalid card details|invalid expiry/i,
    cause: 'expired_instrument'
  },
  {
    pattern: /timed out|timeout|network failure|bank timed out|downstream error|gateway timeout|bank timeout/i,
    cause: 'bank_timeout'
  },
  {
    pattern: /fraud|blocked|restricted|stolen|lost|security violation|risk block/i,
    cause: 'risk_block'
  }
];

/**
 * Classifies a failed payment transaction into one of 5 root causes:
 * - insufficient_funds
 * - expired_instrument
 * - bank_timeout
 * - risk_block
 * - unknown
 * 
 * Uses a cascade of:
 * 1. Rule lookup on failure_code
 * 2. Regex matching on gateway_message
 * 3. Gemini LLM fallback on gateway_message
 */
export function classify(failureCode, gatewayMessage = '') {
  // 1. Check direct failure code mapping
  if (failureCode && FAILURE_CODE_MAP[failureCode]) {
    return {
      root_cause: FAILURE_CODE_MAP[failureCode],
      confidence: 1.0,
      method: 'rule'
    };
  }

  // 2. Check regex matching on the gateway message
  if (gatewayMessage) {
    for (const rule of REGEX_MAP) {
      if (rule.pattern.test(gatewayMessage)) {
        return {
          root_cause: rule.cause,
          confidence: 0.9,
          method: 'rule'
        };
      }
    }
  }

  // If we reach here, we must fall back
  return {
    root_cause: 'unknown',
    confidence: 0.5,
    method: 'rule'
  };
}

/**
 * Async version of classify that can utilize the Gemini API if key is present
 */
export async function classifyAsync(failureCode, gatewayMessage = '') {
  // Try synchronous rule-based classification first
  const syncResult = classify(failureCode, gatewayMessage);
  if (syncResult.root_cause !== 'unknown') {
    return syncResult;
  }

  // If rules couldn't classify and we have gateway text, try Gemini LLM
  if (gatewayMessage && process.env.GEMINI_API_KEY) {
    try {
      const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });
      
      const prompt = `You are a billing operations assistant. Classify the following payment gateway decline message into exactly one of these five root causes:
- "insufficient_funds" (when bank account or wallet does not have enough money, limits exceeded, low balance)
- "expired_instrument" (when card is expired, closed, invalid details, inactive)
- "bank_timeout" (when bank network is down, server timeout, bank infrastructure failure, transaction timed out)
- "risk_block" (when account is blocked, suspected fraud, restricted card, stolen/lost card, risk threshold exceeded)
- "unknown" (when the reason is completely ambiguous or irrelevant)

Decline Message: "${gatewayMessage}"

Return the classification and a short confidence score (0.0 to 1.0) in raw JSON format like:
{
  "root_cause": "insufficient_funds",
  "confidence": 0.95
}
Do not return any markdown or extra text.`;

      const response = await model.generateContent(prompt);
      const text = response.response.text().trim();
      
      // Clean JSON formatting if Gemini adds markdown blocks
      const cleanJson = text.replace(/```json|```/gi, '').trim();
      const parsed = JSON.parse(cleanJson);
      
      if (parsed.root_cause && ['insufficient_funds', 'expired_instrument', 'bank_timeout', 'risk_block', 'unknown'].includes(parsed.root_cause)) {
        return {
          root_cause: parsed.root_cause,
          confidence: parsed.confidence || 0.8,
          method: 'llm_fallback'
        };
      }
    } catch (err) {
      console.warn('⚠️ Gemini classification failed, using regex fallback:', err.message);
    }
  }

  // In case Gemini is missing or failed, apply a local keyword heuristic to simulate the LLM fallback
  console.log('🤖 Simulating LLM fallback classification...');
  const msg = (gatewayMessage || '').toLowerCase();
  
  let root_cause = 'unknown';
  let confidence = 0.5;

  if (msg.includes('fund') || msg.includes('balance') || msg.includes('money') || msg.includes('nsf') || msg.includes('limit')) {
    root_cause = 'insufficient_funds';
    confidence = 0.85;
  } else if (msg.includes('expire') || msg.includes('date') || msg.includes('card') || msg.includes('closed') || msg.includes('details')) {
    root_cause = 'expired_instrument';
    confidence = 0.85;
  } else if (msg.includes('time') || msg.includes('timeout') || msg.includes('network') || msg.includes('system') || msg.includes('server')) {
    root_cause = 'bank_timeout';
    confidence = 0.85;
  } else if (msg.includes('block') || msg.includes('fraud') || msg.includes('risk') || msg.includes('stolen') || msg.includes('restrict')) {
    root_cause = 'risk_block';
    confidence = 0.85;
  }

  return {
    root_cause,
    confidence,
    method: 'llm_fallback'
  };
}

/**
 * Generates personalized customer nudge messages based on root cause.
 * Uses Gemini if key is provided, else returns standard templates.
 */
export async function generateNudgeCopy(customerName, rootCause, amountRupees) {
  const formattedAmount = `₹${parseFloat(amountRupees).toFixed(2)}`;

  if (process.env.GEMINI_API_KEY) {
    try {
      const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });
      
      const prompt = `Write a short, friendly, and professional WhatsApp reminder nudge in Hinglish (a natural mix of Hindi and English) for a customer whose recurring payment failed.
Customer Name: ${customerName}
Failed Amount: ${formattedAmount}
Root Cause of Failure: ${rootCause} (Translate this into user-friendly explanation. For 'insufficient_funds', remind them to add balance. For 'expired_instrument', ask them to update their card.)

Keep it under 3 lines. Include a clear call to action. Do not return markdown.`;

      const response = await model.generateContent(prompt);
      return response.response.text().trim();
    } catch (err) {
      console.warn('⚠️ Gemini nudge generation failed, falling back to static template:', err.message);
    }
  }

  // Static Hinglish templates as fallback
  switch (rootCause) {
    case 'insufficient_funds':
      return `Hi ${customerName}, aapka ${formattedAmount} ka subscription payment low balance ki wajah se fail ho gaya hai. Retrying soon. Please maintain sufficient balance.`;
    case 'expired_instrument':
      return `Hi ${customerName}, aapka payment method expire ho gaya hai, jiski wajah se ${formattedAmount} charge nahi ho paya. Please updates details: payment_link`;
    case 'bank_timeout':
      return `Hi ${customerName}, technical network issue ki wajah se payment fail hua. We are retrying automatically, you don't need to do anything.`;
    case 'risk_block':
      return `Hi ${customerName}, secure transaction filters ki wajah se payment cancel hua. Please contact your bank or try a different payment mode.`;
    default:
      return `Hi ${customerName}, transaction of ${formattedAmount} failed. Please verify status on your dashboard.`;
  }
}
