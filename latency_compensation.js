import chalk from "chalk";

/**
 * Latency Compensation Module
 * Compensates for execution lag when reacting to delayed signals (e.g., minutes late from Yellowstone)
 */

// Configuration constants
const LATENCY_CONFIG = {
  // Maximum acceptable delay in milliseconds (beyond this, skip or be very conservative)
  MAX_ACCEPTABLE_DELAY_MS: parseInt(process.env.MAX_ACCEPTABLE_DELAY_MS) || 300000, // 5 minutes
  
  // Delay thresholds for different strategies
  LOW_DELAY_THRESHOLD_MS: parseInt(process.env.LOW_DELAY_THRESHOLD_MS) || 30000, // 30 seconds
  MEDIUM_DELAY_THRESHOLD_MS: parseInt(process.env.MEDIUM_DELAY_THRESHOLD_MS) || 120000, // 2 minutes
  HIGH_DELAY_THRESHOLD_MS: parseInt(process.env.HIGH_DELAY_THRESHOLD_MS) || 300000, // 5 minutes
  
  // Price adjustment factor per minute of delay (conservative estimate)
  PRICE_ADJUSTMENT_PER_MINUTE: parseFloat(process.env.PRICE_ADJUSTMENT_PER_MINUTE) || 0.02, // 2% per minute
  
  // Maximum price adjustment (cap the adjustment)
  MAX_PRICE_ADJUSTMENT: parseFloat(process.env.MAX_PRICE_ADJUSTMENT) || 0.15, // 15% max adjustment
  
  // Enable/disable latency compensation
  ENABLED: process.env.ENABLE_LATENCY_COMPENSATION !== "false", // Default true
};

// Track recent transaction timestamps for delay calculation
const transactionTimestampCache = new Map(); // signature -> timestamp

function utcNow() {
  return new Date().toISOString();
}

/**
 * Record transaction timestamp for delay calculation
 */
export function recordTransactionTimestamp(signature, transactionTimestamp) {
  if (!signature || !transactionTimestamp) return;
  
  transactionTimestampCache.set(signature, transactionTimestamp);
  
  // Cleanup old entries (keep last 1000)
  if (transactionTimestampCache.size > 1000) {
    const entries = Array.from(transactionTimestampCache.entries());
    entries.sort((a, b) => b[1] - a[1]); // Sort by timestamp desc
    transactionTimestampCache.clear();
    entries.slice(0, 1000).forEach(([sig, ts]) => {
      transactionTimestampCache.set(sig, ts);
    });
  }
}

/**
 * Calculate delay from transaction time to current time
 */
export function calculateDelay(transactionTimestamp) {
  if (!transactionTimestamp) return null;
  
  const now = Date.now();
  const transactionTime = typeof transactionTimestamp === 'number' 
    ? transactionTimestamp 
    : new Date(transactionTimestamp).getTime();
  
  const delayMs = now - transactionTime;
  
  return {
    delayMs,
    delaySeconds: delayMs / 1000,
    delayMinutes: delayMs / 60000,
    isAcceptable: delayMs <= LATENCY_CONFIG.MAX_ACCEPTABLE_DELAY_MS,
    delayLevel: getDelayLevel(delayMs)
  };
}

/**
 * Get delay level category
 */
function getDelayLevel(delayMs) {
  if (delayMs <= LATENCY_CONFIG.LOW_DELAY_THRESHOLD_MS) return 'low';
  if (delayMs <= LATENCY_CONFIG.MEDIUM_DELAY_THRESHOLD_MS) return 'medium';
  if (delayMs <= LATENCY_CONFIG.HIGH_DELAY_THRESHOLD_MS) return 'high';
  return 'critical';
}

/**
 * Calculate price adjustment based on delay
 * For sells: be more conservative (expect price may have dropped)
 * For buys: be more conservative (expect price may have risen)
 */
export function calculatePriceAdjustment(delayInfo, action = "SELL") {
  if (!LATENCY_CONFIG.ENABLED || !delayInfo || !delayInfo.isAcceptable) {
    return { adjustmentFactor: 1.0, shouldSkip: true };
  }
  
  // Calculate adjustment based on delay
  const delayMinutes = delayInfo.delayMinutes;
  const adjustmentPerMinute = LATENCY_CONFIG.PRICE_ADJUSTMENT_PER_MINUTE;
  
  // For sells: reduce expected price (market may have dropped)
  // For buys: increase expected price (market may have risen)
  let adjustmentFactor = 1.0;
  
  if (action === "SELL") {
    // Be conservative: assume price may have dropped
    adjustmentFactor = 1.0 - (delayMinutes * adjustmentPerMinute);
    adjustmentFactor = Math.max(adjustmentFactor, 1.0 - LATENCY_CONFIG.MAX_PRICE_ADJUSTMENT);
  } else {
    // For buys: assume price may have risen
    adjustmentFactor = 1.0 + (delayMinutes * adjustmentPerMinute);
    adjustmentFactor = Math.min(adjustmentFactor, 1.0 + LATENCY_CONFIG.MAX_PRICE_ADJUSTMENT);
  }
  
  // Determine if we should skip based on delay level
  let shouldSkip = false;
  let warning = null;
  
  if (delayInfo.delayLevel === 'critical') {
    shouldSkip = true;
    warning = `Critical delay (${delayInfo.delayMinutes.toFixed(1)} min) - skipping trade`;
  } else if (delayInfo.delayLevel === 'high') {
    warning = `High delay (${delayInfo.delayMinutes.toFixed(1)} min) - using conservative pricing`;
  }
  
  return {
    adjustmentFactor,
    shouldSkip,
    warning,
    delayInfo
  };
}

/**
 * Get adjusted target price based on latency
 */
export function getAdjustedTargetPrice(originalPrice, delayInfo, action = "SELL") {
  if (!LATENCY_CONFIG.ENABLED || !delayInfo) {
    return originalPrice;
  }
  
  const adjustment = calculatePriceAdjustment(delayInfo, action);
  
  if (adjustment.shouldSkip) {
    return null; // Signal to skip trade
  }
  
  const adjustedPrice = originalPrice * adjustment.adjustmentFactor;
  
  return {
    originalPrice,
    adjustedPrice,
    adjustment: adjustment
  };
}

/**
 * Check if transaction should be executed based on delay
 */
export function shouldExecuteTrade(transactionTimestamp, action = "SELL") {
  if (!LATENCY_CONFIG.ENABLED) {
    return { shouldExecute: true, reason: "Latency compensation disabled" };
  }
  
  const delayInfo = calculateDelay(transactionTimestamp);
  
  if (!delayInfo) {
    return { shouldExecute: true, reason: "No delay info available" };
  }
  
  const adjustment = calculatePriceAdjustment(delayInfo, action);
  
  return {
    shouldExecute: !adjustment.shouldSkip,
    delayInfo,
    adjustment,
    reason: adjustment.warning || "Acceptable delay"
  };
}

/**
 * Get conservative sell amount based on delay
 * For high delays, reduce sell size to minimize impact
 */
export function getConservativeSellAmount(originalAmount, delayInfo) {
  if (!delayInfo || delayInfo.delayLevel === 'low') {
    return originalAmount;
  }
  
  // For medium/high delay, reduce sell size
  const reductionFactors = {
    'medium': 0.8, // Reduce by 20%
    'high': 0.6,   // Reduce by 40%
    'critical': 0.0 // Skip entirely
  };
  
  const factor = reductionFactors[delayInfo.delayLevel] || 1.0;
  
  return Math.floor(originalAmount * factor);
}

/**
 * Log latency compensation info
 */
export function logLatencyCompensation(delayInfo, adjustment, tokenMint, action) {
  const shortMint = tokenMint ? tokenMint.slice(0, 8) + "..." : "unknown";
  
  console.log(chalk.cyan(`[${utcNow()}] ⏱️ Latency Compensation for ${action} ${shortMint}:`));
  console.log(chalk.cyan(`   • Delay: ${delayInfo.delayMinutes.toFixed(2)} minutes (${delayInfo.delayLevel})`));
  
  if (adjustment.shouldSkip) {
    console.log(chalk.red(`   • ❌ SKIP: ${adjustment.warning}`));
  } else {
    console.log(chalk.cyan(`   • Price adjustment: ${((adjustment.adjustmentFactor - 1) * 100).toFixed(2)}%`));
    if (adjustment.warning) {
      console.log(chalk.yellow(`   • ⚠️ Warning: ${adjustment.warning}`));
    }
  }
}

/**
 * Get delay stats for monitoring
 */
export function getDelayStats() {
  const delays = Array.from(transactionTimestampCache.values())
    .map(ts => calculateDelay(ts))
    .filter(d => d !== null);
  
  if (delays.length === 0) {
    return {
      count: 0,
      avgDelaySeconds: 0,
      maxDelaySeconds: 0,
      minDelaySeconds: 0
    };
  }
  
  const delaySeconds = delays.map(d => d.delaySeconds);
  
  return {
    count: delays.length,
    avgDelaySeconds: delaySeconds.reduce((sum, d) => sum + d, 0) / delaySeconds.length,
    maxDelaySeconds: Math.max(...delaySeconds),
    minDelaySeconds: Math.min(...delaySeconds),
    levels: {
      low: delays.filter(d => d.delayLevel === 'low').length,
      medium: delays.filter(d => d.delayLevel === 'medium').length,
      high: delays.filter(d => d.delayLevel === 'high').length,
      critical: delays.filter(d => d.delayLevel === 'critical').length
    }
  };
}

