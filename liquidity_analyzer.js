import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import chalk from "chalk";

/**
 * Liquidity Analyzer Module
 * Analyzes pool depth and calculates safe trade sizes to minimize slippage
 */

// Configuration constants
const LIQUIDITY_CONFIG = {
  // Maximum percentage of pool to trade in a single chunk (5-10% recommended)
  MAX_POOL_PERCENTAGE_PER_CHUNK: parseFloat(process.env.MAX_POOL_PERCENTAGE_PER_CHUNK) || 0.07, // 7%
  
  // Minimum liquidity threshold in SOL (below this, avoid trading)
  MIN_SAFE_LIQUIDITY_SOL: parseFloat(process.env.MIN_SAFE_LIQUIDITY_SOL) || 10.0,
  
  // Minimum chunk size in SOL (if calculated chunk is smaller, skip or wait)
  MIN_CHUNK_SIZE_SOL: parseFloat(process.env.MIN_CHUNK_SIZE_SOL) || 0.1,
  
  // Maximum chunks to split a position into
  MAX_CHUNKS: parseInt(process.env.MAX_SELL_CHUNKS) || 10,
  
  // Delay between chunks in milliseconds
  CHUNK_DELAY_MS: parseInt(process.env.CHUNK_DELAY_MS) || 2000, // 2 seconds
  
  // Price impact threshold (if impact > this, split into more chunks)
  MAX_PRICE_IMPACT_BPS: parseInt(process.env.MAX_PRICE_IMPACT_BPS) || 300, // 3%
};

function utcNow() {
  return new Date().toISOString();
}

/**
 * Calculate pool depth from context based on pool type
 */
function getPoolDepth(context, poolStatus) {
  let solLiquidity = 0;
  let tokenReserves = 0;
  
  try {
    if (poolStatus === "pumpfun") {
      // PumpFun: virtual reserves
      const virtualSolReserves = BigInt(context.virtualSolReserves || 0);
      const virtualTokenReserves = BigInt(context.virtualTokenReserves || 0);
      solLiquidity = Number(virtualSolReserves) / LAMPORTS_PER_SOL;
      tokenReserves = Number(virtualTokenReserves);
    } else if (poolStatus === "pumpswap" || poolStatus === "pumpswap_direct") {
      // PumpSwap: actual reserves
      const poolQuoteTokenReserves = BigInt(context.poolQuoteTokenReserves || 0);
      const poolBaseTokenReserves = BigInt(context.poolBaseTokenReserves || 0);
      solLiquidity = Number(poolQuoteTokenReserves) / LAMPORTS_PER_SOL;
      tokenReserves = Number(poolBaseTokenReserves);
    } else {
      // Raydium or others: use liquidity field if available
      if (context.liquidity) {
        solLiquidity = typeof context.liquidity === 'string' 
          ? parseFloat(context.liquidity) 
          : Number(context.liquidity);
      }
    }
  } catch (error) {
    console.error(chalk.red(`[${utcNow()}] ❌ Error calculating pool depth: ${error.message}`));
    return { solLiquidity: 0, tokenReserves: 0 };
  }
  
  return { solLiquidity, tokenReserves };
}

/**
 * Calculate price impact of a trade
 * Uses constant product formula: (x * y) = k
 * Price impact = (amount / liquidity) * 100
 */
function calculatePriceImpact(tradeAmount, poolLiquidity) {
  if (poolLiquidity <= 0) return Infinity;
  
  // Simple linear approximation for small trades
  // For larger trades, would need to calculate exact AMM curve
  const impactBps = (tradeAmount / poolLiquidity) * 10000;
  return impactBps;
}

/**
 * Calculate optimal chunk size based on pool depth
 */
function calculateOptimalChunkSize(positionSize, poolLiquidity, poolStatus) {
  // Calculate max chunk size as percentage of pool
  const maxChunkSol = poolLiquidity * LIQUIDITY_CONFIG.MAX_POOL_PERCENTAGE_PER_CHUNK;
  
  // Estimate token price (rough approximation)
  let estimatedPrice = 0;
  if (poolStatus === "pumpfun") {
    // For PumpFun, use virtual reserves ratio
    // This is approximate - actual price would need AMM calculation
    estimatedPrice = 1 / (poolLiquidity * LAMPORTS_PER_SOL / Math.max(1, poolLiquidity));
  } else {
    // For PumpSwap, we'd need token reserves from context
    // For now, use a conservative estimate
    estimatedPrice = poolLiquidity > 0 ? 1 : 0;
  }
  
  // Calculate max chunk in tokens (approximate)
  // If we have position size in tokens, limit to percentage of pool
  const maxChunkTokens = positionSize * LIQUIDITY_CONFIG.MAX_POOL_PERCENTAGE_PER_CHUNK;
  
  // Ensure chunk meets minimum size
  const minChunkTokens = (LIQUIDITY_CONFIG.MIN_CHUNK_SIZE_SOL * LAMPORTS_PER_SOL) / Math.max(estimatedPrice, 1e-9);
  
  // Use the smaller of: max chunk size or position size
  let optimalChunk = Math.min(maxChunkTokens, positionSize);
  
  // Ensure minimum chunk size
  if (optimalChunk < minChunkTokens && positionSize > 0) {
    optimalChunk = Math.min(positionSize, minChunkTokens);
  }
  
  return optimalChunk;
}

/**
 * Analyze liquidity and determine if safe to trade
 */
export function analyzeLiquidity(context, poolStatus, tradeAmount = null) {
  const { solLiquidity, tokenReserves } = getPoolDepth(context, poolStatus);
  
  const analysis = {
    solLiquidity,
    tokenReserves,
    isSafe: solLiquidity >= LIQUIDITY_CONFIG.MIN_SAFE_LIQUIDITY_SOL,
    recommendedChunkSize: null,
    recommendedChunks: 1,
    estimatedPriceImpact: 0,
    warning: null
  };
  
  // Check if liquidity is sufficient
  if (!analysis.isSafe) {
    analysis.warning = `Pool liquidity (${solLiquidity.toFixed(4)} SOL) below minimum safe threshold (${LIQUIDITY_CONFIG.MIN_SAFE_LIQUIDITY_SOL} SOL)`;
    return analysis;
  }
  
  // If trade amount provided, calculate optimal execution
  if (tradeAmount && tradeAmount > 0) {
    const optimalChunk = calculateOptimalChunkSize(tradeAmount, solLiquidity, poolStatus);
    
    // Calculate price impact
    const priceImpactBps = calculatePriceImpact(
      optimalChunk * (solLiquidity > 0 ? solLiquidity / Math.max(tokenReserves, 1) : 1),
      solLiquidity
    );
    
    // Calculate number of chunks needed
    let recommendedChunks = 1;
    if (tradeAmount > optimalChunk) {
      recommendedChunks = Math.ceil(tradeAmount / optimalChunk);
      recommendedChunks = Math.min(recommendedChunks, LIQUIDITY_CONFIG.MAX_CHUNKS);
    }
    
    // If price impact is too high, suggest more chunks
    if (priceImpactBps > LIQUIDITY_CONFIG.MAX_PRICE_IMPACT_BPS && recommendedChunks < LIQUIDITY_CONFIG.MAX_CHUNKS) {
      const additionalChunks = Math.ceil(priceImpactBps / LIQUIDITY_CONFIG.MAX_PRICE_IMPACT_BPS);
      recommendedChunks = Math.min(recommendedChunks + additionalChunks, LIQUIDITY_CONFIG.MAX_CHUNKS);
    }
    
    analysis.recommendedChunkSize = optimalChunk;
    analysis.recommendedChunks = recommendedChunks;
    analysis.estimatedPriceImpact = priceImpactBps;
    
    if (priceImpactBps > LIQUIDITY_CONFIG.MAX_PRICE_IMPACT_BPS) {
      analysis.warning = `High price impact (${(priceImpactBps / 100).toFixed(2)}%). Consider splitting into ${recommendedChunks} chunks.`;
    }
  }
  
  return analysis;
}

/**
 * Split a position into optimal chunks for execution
 */
export function splitIntoChunks(positionSize, context, poolStatus) {
  const analysis = analyzeLiquidity(context, poolStatus, positionSize);
  
  if (!analysis.isSafe) {
    return {
      chunks: [],
      analysis,
      canExecute: false,
      reason: analysis.warning || "Insufficient liquidity"
    };
  }
  
  const chunks = [];
  const chunkSize = analysis.recommendedChunkSize || positionSize;
  const numChunks = analysis.recommendedChunks || 1;
  
  // Calculate actual chunk sizes
  const baseChunkSize = Math.floor(positionSize / numChunks);
  const remainder = positionSize % numChunks;
  
  for (let i = 0; i < numChunks; i++) {
    const chunk = {
      index: i + 1,
      totalChunks: numChunks,
      size: baseChunkSize + (i < remainder ? 1 : 0),
      delayAfter: i < numChunks - 1 ? LIQUIDITY_CONFIG.CHUNK_DELAY_MS : 0 // No delay after last chunk
    };
    chunks.push(chunk);
  }
  
  return {
    chunks,
    analysis,
    canExecute: true,
    totalSize: positionSize,
    estimatedTotalTime: (numChunks - 1) * LIQUIDITY_CONFIG.CHUNK_DELAY_MS
  };
}

/**
 * Get real-time liquidity from on-chain data (if context unavailable)
 * This is a fallback method that fetches pool state directly
 */
export async function fetchPoolLiquidity(poolAddress, connection, poolStatus) {
  try {
    // This would require implementing pool-specific fetching
    // For now, return null and rely on context
    console.log(chalk.yellow(`[${utcNow()}] ⚠️ Real-time liquidity fetching not fully implemented, using context data`));
    return null;
  } catch (error) {
    console.error(chalk.red(`[${utcNow()}] ❌ Error fetching pool liquidity: ${error.message}`));
    return null;
  }
}

/**
 * Log liquidity analysis for debugging
 */
export function logLiquidityAnalysis(analysis, tokenMint) {
  const shortMint = tokenMint ? tokenMint.slice(0, 8) + "..." : "unknown";
  
  console.log(chalk.cyan(`[${utcNow()}] 💧 Liquidity Analysis for ${shortMint}:`));
  console.log(chalk.cyan(`   • SOL Liquidity: ${analysis.solLiquidity.toFixed(4)} SOL`));
  console.log(chalk.cyan(`   • Safe to trade: ${analysis.isSafe ? "✅ YES" : "❌ NO"}`));
  
  if (analysis.recommendedChunkSize) {
    console.log(chalk.cyan(`   • Recommended chunk size: ${analysis.recommendedChunkSize.toLocaleString()} tokens`));
    console.log(chalk.cyan(`   • Recommended chunks: ${analysis.recommendedChunks}`));
    console.log(chalk.cyan(`   • Estimated price impact: ${(analysis.estimatedPriceImpact / 100).toFixed(2)}%`));
  }
  
  if (analysis.warning) {
    console.log(chalk.yellow(`   ⚠️ Warning: ${analysis.warning}`));
  }
}

