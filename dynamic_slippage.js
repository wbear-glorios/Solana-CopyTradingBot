import chalk from "chalk";

/**
 * Dynamic Slippage Module
 * Calculates volatility-based slippage adjustments for hyper-volatile markets
 */

// Configuration constants
const SLIPPAGE_CONFIG = {
  // Base slippage in basis points (100 = 1%)
  BASE_BUY_SLIPPAGE_BPS: parseInt(process.env.BASE_BUY_SLIPPAGE_BPS) || 500, // 5%
  BASE_SELL_SLIPPAGE_BPS: parseInt(process.env.BASE_SELL_SLIPPAGE_BPS) || 300, // 3%
  
  // Volatility multiplier (how much to adjust slippage based on volatility)
  VOLATILITY_MULTIPLIER: parseFloat(process.env.VOLATILITY_MULTIPLIER) || 2.0,
  
  // Minimum slippage (safety floor)
  MIN_SLIPPAGE_BPS: parseInt(process.env.MIN_SLIPPAGE_BPS) || 50, // 0.5%
  
  // Maximum slippage (safety ceiling)
  MAX_SLIPPAGE_BPS: parseInt(process.env.MAX_SLIPPAGE_BPS) || 3000, // 30%
  
  // Price history window (number of recent prices to consider)
  PRICE_HISTORY_WINDOW: parseInt(process.env.PRICE_HISTORY_WINDOW) || 10,
  
  // Time window for volatility calculation (milliseconds)
  VOLATILITY_WINDOW_MS: parseInt(process.env.VOLATILITY_WINDOW_MS) || 60000, // 1 minute
};

// In-memory price history cache: tokenMint -> Array<{price, timestamp}>
const priceHistoryCache = new Map();

function utcNow() {
  return new Date().toISOString();
}

/**
 * Record a price observation for a token
 */
export function recordPrice(tokenMint, price, timestamp = Date.now()) {
  if (!tokenMint || !price || price <= 0) return;
  
  let history = priceHistoryCache.get(tokenMint);
  if (!history) {
    history = [];
    priceHistoryCache.set(tokenMint, history);
  }
  
  // Add new price observation
  history.push({ price, timestamp });
  
  // Clean up old entries (outside volatility window)
  const cutoffTime = timestamp - SLIPPAGE_CONFIG.VOLATILITY_WINDOW_MS;
  while (history.length > 0 && history[0].timestamp < cutoffTime) {
    history.shift();
  }
  
  // Limit history size
  if (history.length > SLIPPAGE_CONFIG.PRICE_HISTORY_WINDOW * 2) {
    history = history.slice(-SLIPPAGE_CONFIG.PRICE_HISTORY_WINDOW);
    priceHistoryCache.set(tokenMint, history);
  }
}

/**
 * Calculate volatility index from price history
 * Returns a value between 0 (low volatility) and 1+ (high volatility)
 */
function calculateVolatility(tokenMint) {
  const history = priceHistoryCache.get(tokenMint);
  
  if (!history || history.length < 2) {
    // No history, assume moderate volatility
    return 0.5;
  }
  
  // Calculate price changes
  const priceChanges = [];
  for (let i = 1; i < history.length; i++) {
    const prevPrice = history[i - 1].price;
    const currPrice = history[i].price;
    if (prevPrice > 0) {
      const change = Math.abs((currPrice - prevPrice) / prevPrice);
      priceChanges.push(change);
    }
  }
  
  if (priceChanges.length === 0) return 0.5;
  
  // Calculate average absolute change (simplified volatility measure)
  const avgChange = priceChanges.reduce((sum, change) => sum + change, 0) / priceChanges.length;
  
  // Calculate variance for better volatility measure
  const variance = priceChanges.reduce((sum, change) => {
    const diff = change - avgChange;
    return sum + (diff * diff);
  }, 0) / priceChanges.length;
  
  const volatility = Math.sqrt(variance);
  
  // Normalize to 0-1 range, but allow higher values for extreme volatility
  const normalizedVolatility = Math.min(volatility * 10, 2.0); // Cap at 2x multiplier
  
  return normalizedVolatility;
}

/**
 * Calculate dynamic slippage based on volatility
 */
export function calculateDynamicSlippage(tokenMint, action = "SELL", baseSlippageBps = null) {
  // Use provided base or default
  const baseBps = baseSlippageBps !== null 
    ? baseSlippageBps 
    : (action === "BUY" ? SLIPPAGE_CONFIG.BASE_BUY_SLIPPAGE_BPS : SLIPPAGE_CONFIG.BASE_SELL_SLIPPAGE_BPS);
  
  // Calculate volatility
  const volatility = calculateVolatility(tokenMint);
  
  // Adjust slippage: base + (volatility * multiplier * base)
  // Higher volatility = higher slippage tolerance
  const volatilityAdjustment = volatility * SLIPPAGE_CONFIG.VOLATILITY_MULTIPLIER;
  const adjustedSlippageBps = baseBps * (1 + volatilityAdjustment);
  
  // Apply min/max bounds
  const finalSlippageBps = Math.max(
    SLIPPAGE_CONFIG.MIN_SLIPPAGE_BPS,
    Math.min(adjustedSlippageBps, SLIPPAGE_CONFIG.MAX_SLIPPAGE_BPS)
  );
  
  return {
    baseBps,
    volatility,
    volatilityAdjustment,
    finalBps: Math.round(finalSlippageBps),
    adjustmentFactor: finalSlippageBps / baseBps
  };
}

/**
 * Get slippage for a specific action with context awareness
 */
export function getSlippageForAction(tokenMint, action, poolStatus, context = null) {
  // Check if there's market activity that suggests high volatility
  let volatilityMultiplier = 1.0;
  
  // If context has recent activity indicators, adjust
  if (context) {
    // Check for rapid price movements in context
    // This would require tracking recent transactions
    // For now, rely on price history
  }
  
  // Get base slippage from env or use defaults
  let baseSlippageBps = null;
  if (action === "BUY") {
    baseSlippageBps = parseInt(process.env.BUY_SLIPPAGE_BPS_PERCENTAGE) || SLIPPAGE_CONFIG.BASE_BUY_SLIPPAGE_BPS;
  } else {
    baseSlippageBps = parseInt(process.env.SELL_SLIPPAGE_BPS_PERCENTAGE) || SLIPPAGE_CONFIG.BASE_SELL_SLIPPAGE_BPS;
  }
  
  const result = calculateDynamicSlippage(tokenMint, action, baseSlippageBps);
  
  return result;
}

/**
 * Adjust slippage based on recent market events
 * Call this when detecting rapid price movements or high trading volume
 */
export function adjustSlippageForEvent(tokenMint, eventType, severity = 1.0) {
  // Event types: 'price_spike', 'high_volume', 'low_liquidity', 'whale_movement'
  
  const eventMultipliers = {
    'price_spike': 1.5,
    'high_volume': 1.3,
    'low_liquidity': 1.8,
    'whale_movement': 1.4,
    'default': 1.0
  };
  
  const multiplier = (eventMultipliers[eventType] || eventMultipliers['default']) * severity;
  
  // Record a temporary volatility boost
  // This will affect next slippage calculation
  recordPrice(tokenMint, 0, Date.now()); // Dummy entry to trigger recalculation
  
  return multiplier;
}

/**
 * Get slippage percentage from basis points
 */
export function bpsToPercentage(bps) {
  return bps / 100;
}

/**
 * Log slippage calculation for debugging
 */
export function logSlippageCalculation(result, tokenMint, action) {
  const shortMint = tokenMint ? tokenMint.slice(0, 8) + "..." : "unknown";
  
  console.log(chalk.cyan(`[${utcNow()}] 💱 Dynamic Slippage for ${action} ${shortMint}:`));
  console.log(chalk.cyan(`   • Base: ${result.baseBps} bps (${bpsToPercentage(result.baseBps).toFixed(2)}%)`));
  console.log(chalk.cyan(`   • Volatility: ${(result.volatility * 100).toFixed(2)}%`));
  console.log(chalk.cyan(`   • Adjustment: ${(result.adjustmentFactor * 100).toFixed(1)}%`));
  console.log(chalk.cyan(`   • Final: ${result.finalBps} bps (${bpsToPercentage(result.finalBps).toFixed(2)}%)`));
}

/**
 * Clean up old price history (called periodically)
 */
export function cleanupPriceHistory() {
  const now = Date.now();
  const cutoffTime = now - SLIPPAGE_CONFIG.VOLATILITY_WINDOW_MS * 2; // Keep 2x window
  
  for (const [tokenMint, history] of priceHistoryCache.entries()) {
    const filtered = history.filter(entry => entry.timestamp > cutoffTime);
    if (filtered.length === 0) {
      priceHistoryCache.delete(tokenMint);
    } else {
      priceHistoryCache.set(tokenMint, filtered);
    }
  }
}

// Auto-cleanup every 5 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(cleanupPriceHistory, 5 * 60 * 1000);
}

