import fs from "fs";
import path from "path";
import { logToFile } from "./logger.js";
import {
  token_sell,
  token_buy,
  getBondingCurveAddress,
  getTokenHolders,
  getDataFromTx,
  getSplTokenBalance,
  checkTransactionStatus,
  checkWalletBalance,
} from "./fuc.js";
import { EventEmitter } from "events";
import Client from "@triton-one/yellowstone-grpc";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import dotenv from "dotenv";
import crypto from 'crypto';
import { tOutPut } from "./parsingtransaction.js";
// import { sendBuyAlert, sendSellAlert, sendInsufficientFundsAlert, sendBalanceAlert, sendErrorAlert } from "./alert.js";
// import telegramController, { setBotState, getBotState, isBotRunning, updateBotRunningState } from "./telegram_controller.js";
import { fileURLToPath } from "url";
import globalBlockhashManager from "./global_blockhash_manager.js";
import chalk from "chalk";
import { analyzeLiquidity, splitIntoChunks, logLiquidityAnalysis } from "./liquidity_analyzer.js";
import { recordPrice, getSlippageForAction, logSlippageCalculation } from "./dynamic_slippage.js";
import { calculateDelay, shouldExecuteTrade, getConservativeSellAmount, recordTransactionTimestamp, logLatencyCompensation } from "./latency_compensation.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
console.log(__dirname);
dotenv.config();
const buyAmount = process.env.BUY_AMOUNT;
const BUY_AMOUNT_PERCENTAGE = parseFloat(process.env.BUY_AMOUNT_PERCENTAGE) || 0.01; // Percentage of target wallet's SOL change
const GRPC_ENDPOINT = process.env.GRPC_ENDPOINT;
const GRPCTOKEN = process.env.GRPCTOKEN;
const MY_WALLET = process.env.PUB_KEY;
const LIMIT_BALANCE = parseFloat(process.env.LIMIT_BALANCE) || 0.1; // Minimum balance threshold
const ENABLE_INSUFFICIENT_FUNDS_ALERTS = process.env.ENABLE_INSUFFICIENT_FUNDS_ALERTS !== "false"; // Default to true
const INSUFFICIENT_FUNDS_ALERT_COOLDOWN = parseInt(process.env.INSUFFICIENT_FUNDS_ALERT_COOLDOWN) || 5 * 60 * 1000; // 5 minutes default
const ENABLE_COPY_SELL = process.env.ENABLE_COPY_SELL !== "false"; // Default to true

 // Ensure minimum and maximum bounds for safety
 const minAmount = process.env.MIN_AMOUNT || 0.04;
 const maxAmount = process.env.MAX_AMOUNT || 0.5;  // Maximum 0.5 SOL

// In-memory bought tokens cache for copy trading (ULTRA FAST)
let boughtTokensCache = new Map(); // tokenMint -> {amount, buyPrice, buyTime, walletAddress}
const BOUGHT_TOKENS_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours cache
let boughtTokensCleanupInterval = null;

// Enhanced position tracking system for per-wallet copy trading
// Structure: positions[tokenMint][targetWallet] = {purchases: [{amount, buyTime, lastUpdate}], totalAmount}
let positions = new Map(); // tokenMint -> Map(targetWallet -> positionData)

// Global purchase tracking per token
// Structure: tokenPurchaseCounts[tokenMint] = {totalPurchases: number, remainingPurchases: number, lastUpdate: timestamp}
let tokenPurchaseCounts = new Map(); // tokenMint -> purchaseCountData

const POSITION_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours cache
let positionCleanupInterval = null;

// Constants
const SOL_ADDRESS = "So11111111111111111111111111111111111111112";
const RAYDIUM_AUTH_ADDRESS = "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL";
const RAYDIUM_LAUNCHLAB_ADDRESS = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const RAYDIUM_LAUNUNCHPAD_ADDRESS = "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh";
const CONTRACTS_ADDRESS = "DDDD2zvzaPMLuZiC2Vos2i6TLFjJJ3bi1pN7kXQc3R5R"

// Use MY_WALLET and CONTRACTS_ADDRESS as target wallets
let TARGET_WALLET = [MY_WALLET, CONTRACTS_ADDRESS];

// Sends periodic ping messages to keep gRPC streams alive and prevent timeouts
const STREAM_PING_CONFIG = {
  interval: 5000, // Send ping every 5 seconds
  pingId: 1, // Ping ID for tracking
};

// Transaction monitoring configuration
const TRANSACTION_CONFIG = {
  timeout: parseInt(process.env.TRANSACTION_TIMEOUT) || 5000, // 45 seconds timeout for no transactions
  walletCountWindow: parseInt(process.env.WALLET_COUNT_WINDOW) || 1200, // 60 seconds window to count unique wallets
  lowWalletThreshold: parseInt(process.env.LOW_WALLET_THRESHOLD) || 3, // If less than this many unique wallets in window, trigger sell
};

const DYNAMIC_STOPLOSS = {
  minLiquidity: 40, // in SOL, minimum liquidity to consider for stoploss
  minHolders: 30, // minimum holders to consider for stoploss

  lowLiquidityStoplossPnl: -0.03, // more strict if low liquidity/holders
  highLiquidityStoplossPnl: -0.07, // more tolerant if high liquidity/holders
  baseStoplossPnl: -0.03, // default stoploss PNL if no data

  liquidityThreshold: 200, // in SOL, threshold for "high" liquidity
  holdersThreshold: 500, // threshold for "high" holders
};

// Event-driven cooldown system (replaces static cooldowns)
// Cooldowns adjust based on market activity and volatility
const COOLDOWN_CONFIG = {
  // Base cooldowns in milliseconds
  BASE_GLOBAL_COOLDOWN_MS: parseInt(process.env.BASE_GLOBAL_COOLDOWN_MS) || 100,
  BASE_TOKEN_COOLDOWN_MS: parseInt(process.env.BASE_TOKEN_COOLDOWN_MS) || 200,
  
  // Minimum cooldowns (floor)
  MIN_GLOBAL_COOLDOWN_MS: parseInt(process.env.MIN_GLOBAL_COOLDOWN_MS) || 30,
  MIN_TOKEN_COOLDOWN_MS: parseInt(process.env.MIN_TOKEN_COOLDOWN_MS) || 50,
  
  // High activity multiplier (reduce cooldown when market is active)
  HIGH_ACTIVITY_MULTIPLIER: parseFloat(process.env.HIGH_ACTIVITY_MULTIPLIER) || 0.5,
  
  // Low activity multiplier (increase cooldown when market is quiet)
  LOW_ACTIVITY_MULTIPLIER: parseFloat(process.env.LOW_ACTIVITY_MULTIPLIER) || 2.0,
};

// Track last trade timestamps for cooldown calculation
const lastGlobalTradeTime = { timestamp: 0 };
const lastTokenTradeTime = new Map(); // tokenMint -> timestamp

// Track market activity (recent trades per token)
const marketActivityCache = new Map(); // tokenMint -> Array<timestamp>
const ACTIVITY_WINDOW_MS = 60000; // 1 minute window

// Helper functions for event-driven cooldowns
function recordMarketActivity(tokenMint) {
  const now = Date.now();
  let activity = marketActivityCache.get(tokenMint);
  if (!activity) {
    activity = [];
    marketActivityCache.set(tokenMint, activity);
  }
  
  activity.push(now);
  
  // Clean up old entries
  const cutoff = now - ACTIVITY_WINDOW_MS;
  const filtered = activity.filter(ts => ts > cutoff);
  marketActivityCache.set(tokenMint, filtered);
}

function getMarketActivityLevel(tokenMint) {
  const activity = marketActivityCache.get(tokenMint);
  if (!activity || activity.length === 0) return 'low';
  
  // Calculate trades per minute
  const tradesPerMinute = activity.length;
  
  if (tradesPerMinute >= 10) return 'high';
  if (tradesPerMinute >= 5) return 'medium';
  return 'low';
}

function calculateDynamicCooldown(tokenMint, isTokenSpecific = false) {
  const baseCooldown = isTokenSpecific 
    ? COOLDOWN_CONFIG.BASE_TOKEN_COOLDOWN_MS 
    : COOLDOWN_CONFIG.BASE_GLOBAL_COOLDOWN_MS;
  
  const minCooldown = isTokenSpecific
    ? COOLDOWN_CONFIG.MIN_TOKEN_COOLDOWN_MS
    : COOLDOWN_CONFIG.MIN_GLOBAL_COOLDOWN_MS;
  
  // Get market activity level
  const activityLevel = tokenMint ? getMarketActivityLevel(tokenMint) : 'medium';
  
  // Adjust cooldown based on activity
  let multiplier = 1.0;
  if (activityLevel === 'high') {
    multiplier = COOLDOWN_CONFIG.HIGH_ACTIVITY_MULTIPLIER;
  } else if (activityLevel === 'low') {
    multiplier = COOLDOWN_CONFIG.LOW_ACTIVITY_MULTIPLIER;
  }
  
  const adjustedCooldown = baseCooldown * multiplier;
  
  // Ensure minimum cooldown
  return Math.max(adjustedCooldown, minCooldown);
}

function checkCooldown(tokenMint, isBuy = true) {
  const now = Date.now();
  
  // Check global cooldown
  const globalCooldown = calculateDynamicCooldown(null, false);
  const timeSinceGlobalTrade = now - lastGlobalTradeTime.timestamp;
  if (timeSinceGlobalTrade < globalCooldown) {
    return {
      canTrade: false,
      waitTime: globalCooldown - timeSinceGlobalTrade,
      reason: 'global_cooldown'
    };
  }
  
  // Check token-specific cooldown
  if (tokenMint) {
    const tokenCooldown = calculateDynamicCooldown(tokenMint, true);
    const lastTokenTime = lastTokenTradeTime.get(tokenMint) || 0;
    const timeSinceTokenTrade = now - lastTokenTime;
    if (timeSinceTokenTrade < tokenCooldown) {
      return {
        canTrade: false,
        waitTime: tokenCooldown - timeSinceTokenTrade,
        reason: 'token_cooldown'
      };
    }
  }
  
  return { canTrade: true };
}

function updateCooldownTimestamps(tokenMint) {
  const now = Date.now();
  lastGlobalTradeTime.timestamp = now;
  if (tokenMint) {
    lastTokenTradeTime.set(tokenMint, now);
  }
}




export const sellingLocks = new Map(); // key = tokenMint, value = boolean

function utcNow() {
  return new Date().toISOString();
}

// Token Portfolio Management Functions
function createTokenPortfolio() {
  const portfolio = new Map(); // tokenMint -> portfolio data

  function updateTokenEntry(tokenMint, solAmount, isBuy, tokenDecimal, price) {
    let entry = portfolio.get(tokenMint);
    
    if (!entry) {
      entry = {
        tokenMint,
        totalTokens: 0,
        totalSolSpent: 0,
        totalSolReceived: 0,
        averageBuyPrice: 0,
        buyCount: 0,
        sellCount: 0,
        firstBuyTime: null,
        lastUpdateTime: null,
        decimals: tokenDecimal,
        currentPrice: price
      };
    }

    const solAmountInSOL = solAmount / 10**9; // Convert lamports to SOL
    const priceInSOL = price / 10**9; // Convert price to SOL per token

    if (isBuy) {
      // BUY transaction
      entry.totalSolSpent += solAmountInSOL;
      entry.buyCount++;
      
      // Calculate tokens bought
      const tokensBought = solAmountInSOL / priceInSOL;
      entry.totalTokens += tokensBought;
      
      // Update average buy price
      entry.averageBuyPrice = entry.totalSolSpent / entry.totalTokens;
      
      if (!entry.firstBuyTime) entry.firstBuyTime = utcNow();
    } else {
      // SELL transaction
      entry.totalSolReceived += solAmountInSOL;
      entry.sellCount++;
      
      // Calculate tokens sold
      const tokensSold = solAmountInSOL / priceInSOL;
      entry.totalTokens = Math.max(0, entry.totalTokens - tokensSold);
      
      // Recalculate average buy price if we still have tokens
      if (entry.totalTokens > 0) {
        entry.averageBuyPrice = entry.totalSolSpent / entry.totalTokens;
      } else {
        entry.averageBuyPrice = 0;
      }
    }

    entry.currentPrice = priceInSOL;
    entry.lastUpdateTime = utcNow();
    
    portfolio.set(tokenMint, entry);
    return entry;
  }

  function getTokenEntry(tokenMint) {
    return portfolio.get(tokenMint);
  }

  function calculatePnL(tokenMint, currentPrice) {
    const entry = getTokenEntry(tokenMint);
    if (!entry || entry.averageBuyPrice === 0) return 0;
    
    const currentPriceInSOL = currentPrice / 10**9;
    return (currentPriceInSOL - entry.averageBuyPrice) / entry.averageBuyPrice;
  }

  function calculateNetProfit(tokenMint, currentPrice) {
    const entry = getTokenEntry(tokenMint);
    if (!entry) return 0;
    
    const currentPriceInSOL = currentPrice / 10**9;
    const currentValue = entry.totalTokens * currentPriceInSOL;
    return currentValue - entry.totalSolSpent;
  }

  function calculateRealizedPnL(tokenMint) {
    const entry = getTokenEntry(tokenMint);
    if (!entry) return 0;
    
    return entry.totalSolReceived - entry.totalSolSpent;
  }

  function getAllEntries() {
    return Array.from(portfolio.values());
  }

  function deleteEntry(tokenMint) {
    return portfolio.delete(tokenMint);
  }

  return {
    updateTokenEntry,
    getTokenEntry,
    calculatePnL,
    calculateNetProfit,
    calculateRealizedPnL,
    getAllEntries,
    deleteEntry,
    portfolio
  };
}

class TransactionMonitor extends EventEmitter {
  constructor(targetWallet) {
    super();
    this.client = new Client(GRPC_ENDPOINT, GRPCTOKEN);
    this.targetWallet = targetWallet;
    this.tokenPortfolio = createTokenPortfolio();

    this.bots = new Map();
    this.status = new Set();
    this.isRunning = false;
    this.isBuying = false;
    this.lastBuyTimestamp = 0;
    this.pool_status = null;
    this.buyingDisabled = false; // Flag to disable buying when funds are low
    // this.processingTokens = new Set(); // Track tokens currently being processed
    this.lastCopySellTimestamp = 0; // Track last copy sell timestamp for cooldown

    // Add status display interval
    this.statusDisplayInterval = null;
    this.pingInterval = null; // Track ping interval
    
    // Spawn system - similar to Rust's spawn
    this.taskQueue = [];
    this.workerPool = [];
    this.maxWorkers = 20; // Maximum concurrent workers
    this.activeWorkers = 0;
    this.isProcessingQueue = false;
  }

  // Spawn system methods - similar to Rust's spawn
  spawn(taskFunction, ...args) {
    return new Promise((resolve, reject) => {
      const task = {
        id: Date.now() + Math.random(),
        function: taskFunction,
        args: args,
        resolve: resolve,
        reject: reject,
        status: 'pending'
      };
      
      this.taskQueue.push(task);
      this.processQueue();
      
      return task.id;
    });
  }

  async processQueue() {
    if (this.isProcessingQueue || this.taskQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.taskQueue.length > 0 && this.activeWorkers < this.maxWorkers) {
      const task = this.taskQueue.shift();
      if (task) {
        this.executeTask(task);
      }
    }

    this.isProcessingQueue = false;
  }

  async executeTask(task) {
    this.activeWorkers++;
    task.status = 'running';

    try {
      const result = await task.function(...task.args);
      task.status = 'completed';
      task.resolve(result);
    } catch (error) {
      task.status = 'failed';
      task.reject(error);
    } finally {
      this.activeWorkers--;
      // Process next task if available
      if (this.taskQueue.length > 0) {
        this.processQueue();
      }
    }
  }

  // Get spawn system status
  getSpawnStatus() {
    return {
      queueLength: this.taskQueue.length,
      activeWorkers: this.activeWorkers,
      maxWorkers: this.maxWorkers,
      isProcessing: this.isProcessingQueue
    };
  }

  // Add method to get running bot count
  getRunningBotCount() {
    return this.bots.size;
  }

  // Add method to show detailed bot status
  showBotStatus() {
    const runningCount = this.getRunningBotCount();
   
    if (runningCount > 0) {
      console.log(chalk.cyan(`[${utcNow()}] 🤖 Active Trading Bots: ${runningCount} <<<<<<<<<<<<`));
      for (const [tokenMint, bot] of this.bots.entries()) {
        const shortMint = tokenMint.slice(0, 4) + "..." + tokenMint.slice(-4);
        const pnlPercent = bot.pnl ? (bot.pnl * 100).toFixed(2) : "0.00";
        const topPnlPercent = bot.topPnL ? (bot.topPnL * 100).toFixed(2) : "0.00";
        const timeSinceBuy = bot.buyTimestamp ? Math.floor((Date.now() - bot.buyTimestamp) / 1000) : 0;
        const minPnlPercent = bot.minPnl ? (bot.minPnl * 100).toFixed(2) : "0.00";
        const stoplossPercent = bot.dynamicStoplossPnl ? (bot.dynamicStoplossPnl * 100).toFixed(2) : "0.00";
        const timeSinceLastTx = 0; // No longer tracking last transaction time
        const walletCount = bot.walletHistory ? bot.walletHistory.size : 0;

        // Calculate maximum strategy values for display
        const maxTrailingFactorPercent = bot.maxTrailingFactorValue ? (bot.maxTrailingFactorValue * 100).toFixed(2) : "0.00";
        const maxStopPercentagePercent = bot.maxStopPercentageValue ? (bot.maxStopPercentageValue * 100).toFixed(2) : "0.00";
        const maxTrailingFactorLevel = bot.maxTrailingFactorLevel ? bot.maxTrailingFactorLevel.toFixed(1) : "0.0";
        const maxStopPercentageLevel = bot.maxStopPercentageLevel ? bot.maxStopPercentageLevel.toFixed(1) : "0.0";

        // Improved stoploss status
        const improvedStoplossStatus = bot.minPnLBreached
          ? bot.pnlZeroAfterMinPnLBreach
            ? "🚨 IMPROVED STOPLOSS ACTIVE"
            : "⚠️ MinPnL BREACHED"
          : "";

        console.log(
          chalk.bgBlackBright.white(
            `   • ${shortMint} | PnL: ${pnlPercent}% | Top: ${topPnlPercent}% | MinPnL: ${minPnlPercent}% | StopLoss: ${stoplossPercent}% | MaxTrail: ${maxTrailingFactorPercent}%(${maxTrailingFactorLevel}x) | MaxStop: ${maxStopPercentagePercent}%(${maxStopPercentageLevel}x) | Time: ${timeSinceBuy}s | Wallets: ${walletCount} (${timeSinceLastTx}s ago) ${improvedStoplossStatus}`
          )
        );
      }
    }
    
    // Show spawn system status
    const spawnStatus = this.getSpawnStatus();
    if (spawnStatus.activeWorkers > 0 || spawnStatus.queueLength > 0) {
      console.log(chalk.magenta(`[${utcNow()}] 🚀 Spawn System: ${spawnStatus.activeWorkers}/${spawnStatus.maxWorkers} workers active, ${spawnStatus.queueLength} tasks queued`));
    }
    
    // // Show processing tokens
    // if (this.processingTokens.size > 0) {
    //   const processingList = Array.from(this.processingTokens).map(mint => mint.slice(0, 6) + "...").join(", ");
    //   console.log(chalk.yellow(`[${utcNow()}] ⚙️ Processing: ${processingList}`));
    // }
  }

  // Add method to log debug information for all bots
  logAllBotsDebugInfo() {
    const runningCount = this.getRunningBotCount();
    if (runningCount === 0) {
      console.log(chalk.cyan(`[${utcNow()}] 📊 No active bots to debug`));
      return;
    }

    console.log(chalk.cyan(`[${utcNow()}] 🔍 DEBUGGING ALL BOTS (${runningCount} active)`));
    for (const [tokenMint, bot] of this.bots.entries()) {
      bot.logStrategyDebugInfo();
    }
  }

  // Add method to start periodic status display
  startStatusDisplay(intervalMs = 5000) {
    // Default: every 5 seconds
    if (this.statusDisplayInterval) {
      clearInterval(this.statusDisplayInterval);
    }

    this.statusDisplayInterval = setInterval(() => {
      this.showBotStatus();
    }, intervalMs);

    console.log(chalk.cyan(`[${utcNow()}] 📊 Status display started (every ${intervalMs / 1000}s)`));
  }

  // Add method to stop status display
  stopStatusDisplay() {
    if (this.statusDisplayInterval) {
      clearInterval(this.statusDisplayInterval);
      this.statusDisplayInterval = null;
      console.log(chalk.cyan(`[${utcNow()}] 📊 Status display stopped`));
    }
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;


    // Start status display
    this.startStatusDisplay(5000); // Show status every 5 seconds

    const args = this.buildSubscriptionArgs();
    const RETRY_DELAY = 1000;

    while (this.isRunning) {
      let stream;
      try {
        stream = await this.client.subscribe();

        // Setup handlers
        this.setupStreamHandlers(stream);

        await new Promise((resolve, reject) => {
          stream.write(args, (err) => {
            err ? reject(err) : resolve();
          });
        }).catch((err) => {
          console.error("Failed to send subscription request:", err);
          throw err;
        });

        // Start ping interval to keep stream alive
        this.startPingInterval(stream);

        // Wait for stream to close or error
        await new Promise((resolve) => {
          let settled = false;
          stream.on("error", (error) => {
            if (!settled) {
              settled = true;
              console.error(`[${utcNow()}] Stream Error3:`, error);
              resolve(); // Don't reject, just resolve to allow retry
            }
          });

          stream.on("end", () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          });
          stream.on("close", () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          });
        });

        // If we get here, the stream ended/errored, so retry after delay
        console.error(`[${utcNow()}] Stream ended or errored, retrying in 1 seconds...`);
        await new Promise((res) => setTimeout(res, RETRY_DELAY));
      } catch (error) {
        console.error(`[${utcNow()}] Stream error, retrying in 1 seconds...`, error);
        await new Promise((res) => setTimeout(res, RETRY_DELAY));
      }
    }
  }

  async stop() {
    this.isRunning = false;
    this.stopStatusDisplay();

    // Clear ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    // Stop all running bots
    for (const [tokenMint, bot] of this.bots.entries()) {
      await bot.stop();
    }

    console.log(chalk.cyan(`[${utcNow()}] 🛑 TransactionMonitor stopped. Total bots stopped: ${this.bots.size}`));
  }

  buildSubscriptionArgs() {
    return {
      accounts: {},
      slots: {},
      transactions: {
        pump: {
          vote: false,
          failed: false,
          signature: undefined,
          accountInclude: [this.targetWallet],
          accountExclude: [],
          accountRequired: [],
        },
      },
      transactionsStatus: {},
      entry: {},
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      ping: undefined,
      commitment: CommitmentLevel.PROCESSED,
    };
  }

  setupStreamHandlers(stream) {
    stream.on("data", this.handleTransaction.bind(this));
  }

  startPingInterval(stream) {
    // Clear any existing ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    // Create ping request
    const pingRequest = {
      accounts: {},
      slots: {},
      transactions: {},
      transactionsStatus: {},
      entry: {},
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      ping: { id: STREAM_PING_CONFIG.pingId },
    };

    // Start ping interval
    this.pingInterval = setInterval(async () => {
      if (!this.isRunning || !stream) {
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
        return;
      }

      try {
        await new Promise((resolve, reject) => {
          stream.write(pingRequest, (err) => {
            if (err === null || err === undefined) {
              resolve();
            } else {
              reject(err);
            }
          });
        });
        // Optional: Log successful ping (uncomment for debugging)
        // console.log(chalk.cyan(`[${utcNow()}] [Monitor ${this.targetWallet.slice(0, 8)}...] Ping sent successfully`));
      } catch (error) {
        console.error(chalk.red(`[${utcNow()}] [Monitor ${this.targetWallet.slice(0, 8)}...] Ping failed:`, error));
        // If ping fails, the stream might be dead, so we should stop
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
      }
    }, STREAM_PING_CONFIG.interval);

    console.log(
      chalk.blue(
        `[${utcNow()}] [Monitor ${this.targetWallet.slice(0, 8)}...] Ping interval started (every ${STREAM_PING_CONFIG.interval / 1000}s)`
      )
    );
  }

  // Method to check if stream is healthy
  isStreamHealthy() {
    return this.isRunning && this.pingInterval;
  }
  
  // Spawnable transaction processing functions
  async processBuyTransaction(transactionData, startTime1) {
    const {
      tokenChanges,
      solChanges,
      tokenMint,
      tokenDecimal,
      user,
      pool_status,
      context,
    } = transactionData;

    const now = Date.now();
       
    // EVENT-DRIVEN COOLDOWN: Check if we should wait based on market activity
    const cooldownCheck = checkCooldown(tokenMint, true);
    if (!cooldownCheck.canTrade) {
      console.log(chalk.cyan(`[${utcNow()}] ⏳ Cooldown active for ${tokenMint?.slice(0, 8)}... (${cooldownCheck.reason}, wait ${cooldownCheck.waitTime}ms)`));
      return { success: false, reason: 'cooldown_active', waitTime: cooldownCheck.waitTime };
    }

    // Update timestamps
    this.lastBuyTimestamp = now;
    updateCooldownTimestamps(tokenMint);

    try {
      // Calculate dynamic buy amount based on percentage of target wallet's SOL change
      const dynamicBuyAmount = calculateDynamicBuyAmount(solChanges, BUY_AMOUNT_PERCENTAGE);
      let finalBuyAmount = dynamicBuyAmount !== null ? dynamicBuyAmount : buyAmount;

      // LIQUIDITY AWARENESS: Analyze pool depth and adjust position size
      if (context) {
        const liquidityAnalysis = analyzeLiquidity(context, pool_status, null);
        logLiquidityAnalysis(liquidityAnalysis, tokenMint);
        
        // Check if pool has sufficient liquidity
        if (!liquidityAnalysis.isSafe) {
          console.log(chalk.yellow(`[${utcNow()}] ⚠️ BUY WARNING: Pool liquidity (${liquidityAnalysis.solLiquidity.toFixed(4)} SOL) below safe threshold`));
          
          // If liquidity is very low, skip the buy
          if (liquidityAnalysis.solLiquidity < 5.0) {
            console.log(chalk.red(`[${utcNow()}] ❌ BUY SKIPPED: Pool too shallow (${liquidityAnalysis.solLiquidity.toFixed(4)} SOL)`));
            return { success: false, reason: 'pool_too_shallow', analysis: liquidityAnalysis };
          }
        }
        
        // Calculate maximum safe buy amount (percentage of pool)
        const MAX_BUY_POOL_PERCENTAGE = parseFloat(process.env.MAX_BUY_POOL_PERCENTAGE) || 0.10; // 10% max
        const maxSafeBuyAmount = liquidityAnalysis.solLiquidity * MAX_BUY_POOL_PERCENTAGE;
        
        // Adjust buy amount if it exceeds safe limit
        if (finalBuyAmount > maxSafeBuyAmount) {
          const originalAmount = finalBuyAmount;
          finalBuyAmount = maxSafeBuyAmount;
          console.log(chalk.cyan(`[${utcNow()}] 📊 POSITION SIZING: Reduced buy from ${originalAmount.toFixed(4)} to ${finalBuyAmount.toFixed(4)} SOL (${(MAX_BUY_POOL_PERCENTAGE * 100).toFixed(1)}% of pool)`));
        } else {
          const percentageOfPool = (finalBuyAmount / liquidityAnalysis.solLiquidity) * 100;
          console.log(chalk.cyan(`[${utcNow()}] 📊 POSITION SIZING: Buy amount ${finalBuyAmount.toFixed(4)} SOL (${percentageOfPool.toFixed(2)}% of pool)`));
        }
        
        // Ensure minimum buy amount
        const MIN_BUY_AMOUNT = parseFloat(minAmount) || 0.04;
        if (finalBuyAmount < MIN_BUY_AMOUNT) {
          console.log(chalk.yellow(`[${utcNow()}] ⚠️ BUY SKIPPED: Adjusted amount (${finalBuyAmount.toFixed(4)} SOL) below minimum (${MIN_BUY_AMOUNT} SOL)`));
          return { success: false, reason: 'below_minimum_after_adjustment' };
        }
      }

      const {txid, token_amount} = await token_buy(tokenMint, finalBuyAmount, pool_status, context);
      const endTime2 = performance.now();
      const durationUs2 = Math.round((endTime2 - startTime1) * 1000);
      console.log(`[${utcNow()}] 🎯 Time taken to get setup after buy: ${durationUs2}μs`);
      console.log(chalk.bgGreen.black(`[${utcNow()}] ✅ Token buy executed for: ${tokenMint} (amount: ${finalBuyAmount.toFixed(4)} SOL)`));
      console.log(chalk.bgGreen.black(`[${utcNow()}] txid: https://solscan.io/tx/${txid}`));
      
      // Record price for volatility tracking
      if (context && tokenDecimal && tokenChanges !== 0) {
        const price = Math.abs(solChanges / (tokenChanges * 10 ** (9 - tokenDecimal))) / 10**9;
        recordPrice(tokenMint, price);
      }
      
      // Record market activity for cooldown adjustment
      recordMarketActivity(tokenMint);
      
      // Calculate target wallet's token amount from transaction data
      const targetTokenAmount = Math.abs(tokenChanges);
      addPosition(tokenMint, user, targetTokenAmount, token_amount);

     
      return { success: true, txid, tokenMint, buyAmount: finalBuyAmount };
    } catch (buyError) {
      const errorMessage = buyError.message || buyError.toString();

      // Handle insufficient funds error
      if (errorMessage.includes("INSUFFICIENT_FUNDS")) {
        console.error(chalk.red(`[${utcNow()}] ❌ INSUFFICIENT_FUNDS: Cannot buy ${tokenMint}`));
        console.error(chalk.red(`[${utcNow()}] 💰 Please add more SOL to your wallet to continue trading`));
        console.error(chalk.red(`[${utcNow()}] ⚠️ DISABLING BUYING - Bot will continue for selling`));
        logToFile(chalk.red(`[${utcNow()}] ❌ INSUFFICIENT_FUNDS: Cannot buy ${tokenMint} - ${errorMessage}`));
        logToFile(chalk.red(`[${utcNow()}] ⚠️ BUYING DISABLED - Bot continues for selling`));

        // Send Telegram notification (only if it's a real insufficient funds error and alerts are enabled)
        if ((errorMessage.includes("insufficient funds") || errorMessage.includes("0x1")) && ENABLE_INSUFFICIENT_FUNDS_ALERTS) {
          try {
            // Extract balance from error message if available
            const balanceMatch = errorMessage.match(/Wallet balance ([\d.]+) SOL/);
            const currentBalance = balanceMatch ? parseFloat(balanceMatch[1]) : 0;

            // await sendInsufficientFundsAlert({
            //   currentBalance: currentBalance,
            //   limitBalance: LIMIT_BALANCE,
            //   walletAddress: MY_WALLET,
            // });
          } catch (telegramError) {
            console.error(chalk.red(`[${utcNow()}] ❌ Failed to send Telegram notification: ${telegramError.message}`));
          }
        }

        // Disable buying instead of stopping the monitor
        this.disableBuying();
        // this.processingTokens.delete(tokenMint);
        console.log(chalk.cyan(`[${utcNow()}] 🧹 Cleaned up failed buy attempt for ${tokenMint}`));
        return;
      }

      // Handle slippage errors
      if (errorMessage.includes("TooLittleSolReceived") || errorMessage.includes("slippage")) {
        console.error(chalk.cyan(`[${utcNow()}] ⚠️ SLIPPAGE ERROR: Price moved unfavorably for ${tokenMint}`));
        logToFile(chalk.cyan(`[${utcNow()}] ⚠️ SLIPPAGE ERROR: ${tokenMint} - ${errorMessage}`));
      }

      // Handle network/RPC errors
      else if (errorMessage.includes("429") || errorMessage.includes("rate limit")) {
        console.error(chalk.cyan(`[${utcNow()}] ⚠️ RATE LIMIT: RPC endpoint is rate limiting for ${tokenMint}`));
        logToFile(chalk.cyan(`[${utcNow()}] ⚠️ RATE LIMIT: ${tokenMint} - ${errorMessage}`));
      }

      // Handle transaction simulation errors
      else if (errorMessage.includes("Simulation failed") || errorMessage.includes("custom program error")) {
        console.error(chalk.red(`[${utcNow()}] ❌ TRANSACTION ERROR: Simulation failed for ${tokenMint}`));
        logToFile(chalk.red(`[${utcNow()}] ❌ TRANSACTION ERROR: ${tokenMint} - ${errorMessage}`));
      }

      // Handle other buy errors
      else {
        console.error(chalk.red(`[${utcNow()}] ❌ Token buy failed: ${errorMessage}`));
        logToFile(chalk.red(`[${utcNow()}] ❌ Token buy failed: ${tokenMint} - ${errorMessage}`));
      }

      // Clean up after any buy error
      // this.processingTokens.delete(tokenMint);
      
      return { success: false, error: errorMessage, tokenMint };
    }
  }

  async processSellTransaction(transactionData) {
    const {
      tokenChanges,
      solChanges,
      isBuy,
      tokenMint,
      tokenDecimal,
      pairAddress,
      user,
      liquidity,
      coinCreator,
      signature,
      context,
      pool_status,
    } = transactionData;

    const shortTokenName = tokenMint ? tokenMint.slice(0, 6) + "..." : "unknown";

    
    // Copy sell logic - if target wallet is selling, copy the sell
    if (user != MY_WALLET && ENABLE_COPY_SELL) {
      
      // Calculate target wallet's sell amount from transaction data
      const targetSellAmount = Math.abs(tokenChanges);
      
      // Get exact sell amount based on target wallet's sell amount
      const sellData = getExactSellAmount(tokenMint, user, targetSellAmount);
      if (!sellData) {
        console.log(chalk.yellow(`[${utcNow()}] ⚠️  SELL: No matching purchase found for ${shortTokenName} from wallet ${user.slice(0, 8)}... (target sell: ${(targetSellAmount || 0).toLocaleString()}), skipping`));
        return { success: false, reason: 'no_matching_purchase' };
      }
      
      let copySellAmount = sellData.ourSellAmount;
      if (copySellAmount <= 0) {
        console.log(chalk.cyan(`[${utcNow()}] ⚠️  SELL: Calculated sell amount is 0 for ${shortTokenName}, skipping`));
        return { success: false, reason: 'zero_sell_amount' };
      }

      // LATENCY COMPENSATION: Check if we should execute based on delay
      let transactionTimestamp = null;
      if (context?.timestamp) {
        transactionTimestamp = typeof context.timestamp === 'string' 
          ? parseInt(context.timestamp) 
          : context.timestamp;
      } else if (signature) {
        // Try to extract timestamp from transaction if available
        // For now, assume current time minus some delay estimation
        transactionTimestamp = Date.now() - 60000; // Estimate 1 minute delay
      }
      
      if (transactionTimestamp) {
        recordTransactionTimestamp(signature, transactionTimestamp);
        const delayInfo = calculateDelay(transactionTimestamp);
        const shouldExecute = shouldExecuteTrade(transactionTimestamp, "SELL");
        
        // Log latency compensation details
        logLatencyCompensation(delayInfo, shouldExecute.adjustment, tokenMint, "SELL");
        
        if (!shouldExecute.shouldExecute) {
          console.log(chalk.red(`[${utcNow()}] ❌ SELL BLOCKED (latency): ${shouldExecute.reason} - delay: ${delayInfo.delayMinutes.toFixed(2)} min`));
          return { success: false, reason: 'latency_too_high', delay: delayInfo };
        }
        
        // Adjust sell amount based on delay (be more conservative with high delays)
        const conservativeAmount = getConservativeSellAmount(copySellAmount, delayInfo);
        
        if (conservativeAmount < copySellAmount) {
          const reductionPercent = ((copySellAmount - conservativeAmount) / copySellAmount * 100).toFixed(1);
          console.log(chalk.yellow(`[${utcNow()}] ⏱️  LATENCY ADJUSTMENT: Reducing sell by ${reductionPercent}% (${copySellAmount.toLocaleString()} → ${conservativeAmount.toLocaleString()} tokens) due to ${delayInfo.delayLevel} delay (${delayInfo.delayMinutes.toFixed(1)} min)`));
        }
        
        // Use conservative amount if calculated
        const adjustedSellAmount = conservativeAmount > 0 ? conservativeAmount : copySellAmount;
        
        if (adjustedSellAmount <= 0) {
          console.log(chalk.red(`[${utcNow()}] ❌ SELL BLOCKED: Adjusted amount is 0 due to ${delayInfo.delayLevel} latency (${delayInfo.delayMinutes.toFixed(1)} min)`));
          return { success: false, reason: 'latency_adjusted_to_zero', delayInfo };
        }
        
        // Update sell amount to conservative value
        copySellAmount = adjustedSellAmount;
        
        // Increase slippage tolerance for delayed trades (market may have moved)
        if (delayInfo.delayLevel === 'high' || delayInfo.delayLevel === 'medium') {
          console.log(chalk.cyan(`[${utcNow()}] 📈 Increasing slippage tolerance for delayed trade (${delayInfo.delayLevel} delay)`));
          // The dynamic slippage module will handle this based on recorded prices
        }
      }
      
      // LIQUIDITY ANALYSIS: Check pool depth before selling
      if (!context) {
        console.log(chalk.yellow(`[${utcNow()}] ⚠️  SELL: No context available for liquidity analysis, proceeding with caution`));
      } else {
        const liquidityAnalysis = analyzeLiquidity(context, pool_status, copySellAmount);
        logLiquidityAnalysis(liquidityAnalysis, tokenMint);
        
        if (!liquidityAnalysis.isSafe) {
          console.log(chalk.red(`[${utcNow()}] ❌  SELL BLOCKED: ${liquidityAnalysis.warning}`));
          return { success: false, reason: 'insufficient_liquidity', analysis: liquidityAnalysis };
        }
        
        // Split into chunks if recommended
        const chunkPlan = splitIntoChunks(copySellAmount, context, pool_status);
        
        if (!chunkPlan.canExecute) {
          console.log(chalk.red(`[${utcNow()}] ❌  SELL BLOCKED: ${chunkPlan.reason}`));
          return { success: false, reason: 'cannot_execute', plan: chunkPlan };
        }
        
        // If we need to split, execute in chunks
        if (chunkPlan.chunks.length > 1) {
          console.log(chalk.cyan(`[${utcNow()}] 📦 Splitting sell into ${chunkPlan.chunks.length} chunks to minimize slippage`));
          
          let totalSold = 0;
          let lastTxid = null;
          
          for (const chunk of chunkPlan.chunks) {
            console.log(chalk.cyan(`[${utcNow()}] 📦 Executing chunk ${chunk.index}/${chunk.totalChunks}: ${chunk.size.toLocaleString()} tokens`));
            
            try {
              const chunkTxid = await token_sell(tokenMint, chunk.size, pool_status, chunk.index === chunk.totalChunks, context);
              
              if (chunkTxid && chunkTxid !== "stop") {
                totalSold += chunk.size;
                lastTxid = chunkTxid;
                console.log(chalk.green(`[${utcNow()}] ✅ Chunk ${chunk.index}/${chunk.totalChunks} executed: https://solscan.io/tx/${chunkTxid}`));
                
                // Wait before next chunk (except after last)
                if (chunk.delayAfter > 0) {
                  console.log(chalk.cyan(`[${utcNow()}] ⏳ Waiting ${chunk.delayAfter}ms before next chunk...`));
                  await new Promise(resolve => setTimeout(resolve, chunk.delayAfter));
                }
              } else {
                console.log(chalk.yellow(`[${utcNow()}] ⚠️  Chunk ${chunk.index} failed or returned stop`));
              }
            } catch (chunkError) {
              console.error(chalk.red(`[${utcNow()}] ❌ Chunk ${chunk.index} error: ${chunkError.message}`));
              // Continue with next chunk
            }
          }
          
          // Update position after all chunks
          if (totalSold > 0) {
            const position = getPosition(tokenMint, user);
            if (position) {
              position.totalAmount -= totalSold;
              position.lastUpdate = Date.now();
            }
            updateTokenPurchaseCount(tokenMint, -1);
            
            return { 
              success: true, 
              txid: lastTxid, 
              amount: totalSold, 
              sellType: "CHUNKED", 
              chunksExecuted: chunkPlan.chunks.length 
            };
          }
          
          return { success: false, reason: 'chunk_execution_failed' };
        }
      }

      // Check remaining purchase count to determine if this is the last purchase being sold
      const remainingPurchases = getRemainingPurchaseCount(tokenMint);
      const isLastPurchase = isLastRemainingPurchase(tokenMint);
      
      // Determine if this is full or partial selling based on remaining purchases
      let isFullSell = false;
      if (remainingPurchases === 1) {
        isFullSell = true;
        console.log(chalk.cyan(`[${utcNow()}] 🎯 FULL SELL: Last remaining purchase for ${shortTokenName} (${remainingPurchases} remaining), executing full sell`));
      } else if (remainingPurchases > 1) {
        isFullSell = false;
        console.log(chalk.cyan(`[${utcNow()}] 🎯 PARTIAL SELL: ${remainingPurchases} purchases remain for ${shortTokenName}, executing partial sell`));
      } else {
        isFullSell = false;
        console.log(chalk.yellow(`[${utcNow()}] ⚠️ UNEXPECTED: No remaining purchases for ${shortTokenName}, defaulting to partial sell`));
      }
        
      // Update copy sell timestamp
      const now = Date.now();
      this.lastCopySellTimestamp = now;
      
      // Execute copy sell using position data
      try {
        const sellType = isFullSell ? "FULL" : "PARTIAL";
        const matchType = sellData.isProportional ? "PROPORTIONAL" : "EXACT";
        console.log(`[${utcNow()}] 🎯 ${sellType} ${matchType} selling ${(copySellAmount || 0).toLocaleString()} tokens for ${shortTokenName} (following ${user.slice(0, 8)}... target: ${(targetSellAmount || 0).toLocaleString()})`);
        
        // Record price for volatility tracking (before executing)
        if (context && tokenDecimal) {
          const price = Math.abs(solChanges / (tokenChanges * 10 ** (9 - tokenDecimal))) / 10**9;
          recordPrice(tokenMint, price);
        }
        
        // Execute sell using position data with full/partial flag
        const txid = await token_sell(tokenMint, copySellAmount, pool_status, isFullSell, context);
        
        if (txid) {
          console.log(chalk.bgGreen.white(`[${utcNow()}] ✅  ${sellType} ${matchType} SELL EXECUTED: ${(copySellAmount || 0).toLocaleString()} tokens sold (following ${user.slice(0, 8)}... target: ${(targetSellAmount || 0).toLocaleString()})`));
          console.log(chalk.bgGreen.white(`[${utcNow()}] ✅  sell txid: https://solscan.io/tx/${txid}`));
          
          // Remove the specific purchase that was sold
          if (sellData.isProportional) {
            const position = getPosition(tokenMint, user);
            if (position) {
              position.totalAmount -= copySellAmount;
              position.lastUpdate = Date.now();
            }
            updateTokenPurchaseCount(tokenMint, -1);
          } else {
            removePurchase(tokenMint, user, targetSellAmount);
          }
          
          return { success: true, txid, amount: copySellAmount, sellType, matchType };
        }
      } catch (copySellError) {
        console.error(chalk.red(`[${utcNow()}] ❌  SELL ERROR: ${copySellError.message}`));
        logToFile(chalk.red(`[${utcNow()}] ❌  SELL ERROR: ${tokenMint} - ${copySellError.message}`));
        return { success: false, error: copySellError.message };
      }
    } else if (user != MY_WALLET && !ENABLE_COPY_SELL) {
      console.log(chalk.cyan(`[${utcNow()}] ⚠️  SELL DISABLED: Target wallet selling ${shortTokenName} but copy sell is disabled`));
      return { success: false, reason: 'copy_sell_disabled' };
    }
    
    return { success: false, reason: 'not_target_wallet' };
  }

  async handleTransaction(data) {
    if (!data?.transaction?.transaction) return;
    
    
    try {
      const transactionData = await this.processTransactionData(data);
      
      const startTime1 = performance.now();
      

      if (!transactionData) {
        // console.log(chalk.cyan(`[${utcNow()}] ⚠️⚠️⚠️ No available transaction data parsed from transaction`));
        return;
      }

      let {
        tokenChanges,
        solChanges,
        isBuy,
        tokenMint,
        tokenDecimal,
        pairAddress,
        user,
        liquidity,
        coinCreator,
        signature,
        context,
        pool_status,
      } = transactionData;
      // this.logTransactionDetails(tokenMint, isBuy, tokenDecimal, tokenChanges, solChanges, pairAddress, user, liquidity, pool_status, signature);
      
      // Validate essential transaction data
      if (tokenChanges === 0) {
        console.log("token change is zero");
        return;
      }
      
      if (!tokenMint) {
        // console.log(chalk.yellow(`[${utcNow()}] ⚠️ Transaction processing error: tokenMint is undefined or null`));
        return;
      }
      
      const shortTokenName = tokenMint ? tokenMint.slice(0, 6) + "..." : "unknown";
      
      if (isBuy) {
        // console.log(chalk.greenBright(`[${utcNow()}] 🟢 BUY transaction detected: ${shortTokenName}`));
        if (!this.isRunning) return;
        
        if (user === MY_WALLET) {
          // console.log(chalk.bgBlue.white(`[${utcNow()}] 🏠 MY WALLET transaction detected: ${shortTokenName} `));
          
          const price = Math.abs(solChanges / (tokenChanges * 10 ** (9 - tokenDecimal))) / 10**9; // Convert to SOL per token
          // Update token portfolio for wallet transactions
          const tokenEntry = this.tokenPortfolio.updateTokenEntry(tokenMint, Math.abs(solChanges), true, tokenDecimal, price);
          
          // Track position for this specific target wallet
          // const boughtAmount = Math.abs(tokenChanges);
          // addPosition(tokenMint, user, boughtAmount);
          
          // // Reset buying flag and cleanup
          // this.processingTokens.delete(tokenMint);
          
          // Send buy alert with proper data
          // await sendBuyAlert({ 
          //   tokenMint, 
          //   amount: (Math.abs(solChanges) / 10**9).toFixed(6) + ' SOL',
          //   price: price.toFixed(8),
          //   txid: signature,
          //   reason: 'wallet_buy'
          // });
        } else {
          // Spawn buy transaction processing
          this.spawn(this.processBuyTransaction.bind(this), transactionData, startTime1)
          .then(result => {
              if (result && result.success) {
                console.log(chalk.green(`[${utcNow()}] ✅ Spawned buy task completed for ${result.tokenMint}`));
              } else if (result && !result.success) {
                console.log(chalk.red(`[${utcNow()}] ❌ Spawned buy task failed for ${result.tokenMint}: ${result.error}`));
              }
            })
            .catch(error => {
              console.error(chalk.red(`[${utcNow()}] ❌ Spawned buy task error: ${error.message}`));
            });
          }
        } else {
          console.log(chalk.magenta(`[${utcNow()}] 🔴 SELL transaction detected: ${shortTokenName}`));
          
          if (user === MY_WALLET) {
            const price = Math.abs(solChanges / (tokenChanges * 10 ** (9 - tokenDecimal))) / 10**9; // Convert to SOL per token
            console.log(chalk.bgBlue.white(`[${utcNow()}] 🏠 MY WALLET transaction detected: ${shortTokenName}`));
            
          // Update token portfolio for wallet transactions
          const tokenEntry = this.tokenPortfolio.updateTokenEntry(tokenMint, Math.abs(solChanges), false, tokenDecimal, price);
          
          // Calculate PnL and net profit using token portfolio
          let pnl = 0;
          let netProfit = 0;
          let topPnL = 0;
          
          if (tokenEntry) {
            // Calculate current PnL based on sell price vs average buy price
            pnl = this.tokenPortfolio.calculatePnL(tokenMint, price);
            
            // Calculate realized PnL (actual profit/loss from this sell)
            netProfit = this.tokenPortfolio.calculateRealizedPnL(tokenMint);
            
            // For now, set topPnL to current PnL (could be enhanced to track historical high)
            topPnL = pnl;
          }
         
          // Send sell alert with PnL and net profit data
          // await sendSellAlert({ 
          //   tokenMint, 
          //   amount: (Math.abs(solChanges) / 10**9).toFixed(6) + ' SOL',
          //   toppnl: topPnL,
          //   pnl: pnl,
          //   txid: signature,
          //   reason: 'wallet_sell',
          //   netProfit: netProfit
          // });
          
          // Log PnL and net profit to console
          const pnlColor = pnl >= 0 ? chalk.green : chalk.red;
          const profitColor = netProfit >= 0 ? chalk.green : chalk.red;
          console.log(pnlColor(`[${utcNow()}] 💰 PnL: ${(pnl * 100).toFixed(2)}% | Net Profit: ${netProfit.toFixed(6)} SOL`));
        } else {
          // Spawn sell transaction processing
          this.spawn(this.processSellTransaction.bind(this), { ...transactionData })
            .then(result => {
              if (result && result.success) {
                console.log(chalk.green(`[${utcNow()}] ✅ Spawned sell task completed for ${tokenMint}`));
              } else if (result && !result.success) {
                console.log(chalk.yellow(`[${utcNow()}] ⚠️ Spawned sell task result: ${result.reason}`));
              }
            })
            .catch(error => {
              console.error(chalk.red(`[${utcNow()}] ❌ Spawned sell task error: ${error.message}`));
            });
        }
      }
     
    } catch (error) {
      console.error(`[${utcNow()}] Transaction processing error:`, error);
    }
  }

  async processTransactionData(data) {
    try {
      const result = await tOutPut(data);
      // console.log(JSON.stringify(result, null, 2));
      if (!result) {
        // console.log(chalk.cyan(`[${utcNow()}] ⚠️ No available transaction data parsed from transaction`));
        // console.log(JSON.stringify(data, null, 2));
        return null;
      }

      let { tokenChanges, solChanges, isBuy, user, mint, pool, liquidity, coinCreator, signature, context, pool_status } = result;

      if (tokenChanges === undefined || solChanges === undefined || isBuy === undefined) {
        console.log(
          chalk.cyan(
            `[${utcNow()}] ⚠️ Missing required transaction data: tokenChanges=${tokenChanges}, solChanges=${solChanges}, isBuy=${isBuy}`
          )
        );
        return null;
      }

      // Initialize mint as undefined to ensure it's always defined
      let tokenMint = mint;
      // console.log("🎈🎈🎈result", result)
      let preTokenBalances = data?.transaction?.transaction?.meta?.preTokenBalances;
      let postTokenBalances = data?.transaction?.transaction?.meta?.postTokenBalances;
      if (data && data.meta && data.transaction) {
        preTokenBalances = data?.meta?.preTokenBalances;
        postTokenBalances = data?.meta?.postTokenBalances;
      }
      let tokenDecimal = 6;

      if (result.pool_status != "raydium") {
        //Pumpfun Pumpswap Raydium_LaunchLab Raydium_LaunchPad
        if (isBuy) {
          postTokenBalances.forEach((balance) => {
            if (balance.mint === SOL_ADDRESS) {
              if (
                result.pool_status == "raydium_launchlab" &&
                balance.owner !== RAYDIUM_LAUNCHLAB_ADDRESS &&
                balance.owner !== RAYDIUM_LAUNUNCHPAD_ADDRESS
              ) {
                user = balance.owner;
              }
            } else {
              tokenDecimal = balance.uiTokenAmount.decimals;
              tokenMint = balance.mint;
              if (
                result.pool_status == "raydium_launchlab" &&
                balance.owner !== RAYDIUM_LAUNCHLAB_ADDRESS &&
                balance.owner !== RAYDIUM_LAUNUNCHPAD_ADDRESS
              ) {
                user = balance.owner;
              }
            }
          });
        } else {
          preTokenBalances.forEach((balance) => {
            if (balance.mint === SOL_ADDRESS) {
              if (
                result.pool_status == "raydium_launchlab" &&
                balance.owner !== RAYDIUM_LAUNCHLAB_ADDRESS &&
                balance.owner !== RAYDIUM_LAUNUNCHPAD_ADDRESS
              ) {
                user = balance.owner;
              }
            } else {
              tokenDecimal = balance.uiTokenAmount.decimals;
              tokenMint = balance.mint;
              if (
                result.pool_status == "raydium_launchlab" &&
                balance.owner !== RAYDIUM_LAUNCHLAB_ADDRESS &&
                balance.owner !== RAYDIUM_LAUNUNCHPAD_ADDRESS
              ) {
                user = balance.owner;
              }
            }
          });
          postTokenBalances.forEach((balance) => {
            if (
              result.pool_status == "raydium_launchlab" &&
              balance.owner !== RAYDIUM_LAUNCHLAB_ADDRESS &&
              balance.owner !== RAYDIUM_LAUNUNCHPAD_ADDRESS
            ) {
              user = balance.owner;
            }
          });
        }
        // if (result.pool == null) {
        //   pool = await getBondingCurveAddress(mint);
        //   console.log(`[${utcNow()}] >>>>>>>>>>>>pumpfun`);
        //   this.pool_status = "pumpfun";
        // }

        if (!isBuy) {
          tokenChanges = -tokenChanges;
        }
      } else {
        //Raydium
        let post_sol;
        let pre_sol;
        let pre_token;
        let post_token;
        postTokenBalances.forEach((balance) => {
          if (balance.owner === RAYDIUM_AUTH_ADDRESS) {
            if (balance.mint === SOL_ADDRESS) {
              post_sol = balance.uiTokenAmount.amount || 0;
            } else {
              post_token = balance.uiTokenAmount.amount || 0;
              tokenDecimal = balance.uiTokenAmount.decimals;
              tokenMint = balance.mint;
              // console.log(mint, user)
            }
          } else {
            if (balance.owner !== RAYDIUM_LAUNCHLAB_ADDRESS && balance.owner !== RAYDIUM_LAUNUNCHPAD_ADDRESS) {
              user = balance.owner;
            }
          }
        });

        preTokenBalances.forEach((balance) => {
          if (balance.owner === RAYDIUM_AUTH_ADDRESS) {
            if (balance.mint === SOL_ADDRESS) {
              pre_sol = balance.uiTokenAmount.amount || 0;
            } else {
              pre_token = balance.uiTokenAmount.amount || 0;
            }
          } else {
            if (balance.owner !== RAYDIUM_LAUNCHLAB_ADDRESS && balance.owner !== RAYDIUM_LAUNUNCHPAD_ADDRESS) {
              user = balance.owner;
            }
          }
        });
        tokenChanges = pre_token - post_token;
        solChanges = pre_sol - post_sol;
        if (tokenChanges > 0) {
          isBuy = true;
        } else {
          isBuy = false;
        }
        liquidity = (2 * pre_sol) / 10 ** 9;
        coinCreator = RAYDIUM_LAUNCHLAB_ADDRESS;
        // console.log("solchange:", solChanges)

        context = null;
      }
      
      // Validate that tokenMint is defined
      if (!tokenMint) {
        // console.log(chalk.yellow(`[${utcNow()}] ⚠️ Warning: tokenMint is undefined, attempting to extract from result.mint`));
        tokenMint = result.mint || null;
      }
      
      // console.log("😉😉😉User:", user);
      // console.log("😉pre:", preTokenBalances);
      // console.log("😉post:", postTokenBalances);

      return {
        tokenChanges,
        solChanges,
        isBuy,
        tokenMint: tokenMint,
        tokenDecimal,
        pairAddress: pool,
        user,
        liquidity,
        coinCreator,
        signature,
        context,
        pool_status,
      };
    } catch (error) {
      console.error(`[${utcNow()}] Error processing transaction data:`, error);
      return null;
    }
  }

  logTransactionDetails(
    tokenMint,
    isBuy,
    tokenDecimal,
    tokenChanges,
    solChanges,
    pairAddress,
    user,
    liquidity,
    pool_status,
    signature
  ) {
    const walletType = user === MY_WALLET ? "MY_WALLET" : "TARGET_WALLET";
    console.log(chalk.bgYellowBright(`[${utcNow()}] ${walletType}`, user));
    console.log(`[${utcNow()}] signature:`, signature, "");
    console.log(`[${utcNow()}] pool_status:`, pool_status, "");
    console.log(`[${utcNow()}] mint:`, isBuy ? chalk.green(tokenMint) : chalk.red(tokenMint));
    console.log(`[${utcNow()}] Decimals`, tokenDecimal);
    console.log(`[${utcNow()}] tokenChanges:`, isBuy ? chalk.green(tokenChanges) : chalk.red(tokenChanges));
    console.log(
      `[${utcNow()}] solChanges:`,
      isBuy ? chalk.green((solChanges / 10 ** 9).toFixed(4)) : chalk.red((solChanges / 10 ** 9).toFixed(3))
    );
    console.log(`[${utcNow()}] pairAddress:`, isBuy ? chalk.green(pairAddress) : chalk.red(pairAddress));
    console.log(`[${utcNow()}] liquidity:`, isBuy ? chalk.green(liquidity) : chalk.red(liquidity), "");
  }
  async shouldBuyToken(tokenMint, pairAddress, liquidity, user) {
    const { holders, totalSupply, top10Percentage } = await getTokenHolders(tokenMint, pairAddress);

    if (holders.length === 0 || totalSupply === 0) {
      console.log(`[${utcNow()}] ❌ No holders or zero supply for ${tokenMint}`);
      return false;
    }

    console.log(`[${utcNow()}] 👥 Holders: ${holders.length}, 🐋 Top10%: ${top10Percentage}%, liquidity:${liquidity}`);
    // // Save the holders/top10/liquidity info to a file inside a folder named by the wallet address.
    // try {
    //   const walletDir = `./wallets/${user}`;
    //   const fileName = `${walletDir}/info.txt`;
    //   let existingData = "";
    //   if (fs.existsSync(fileName)) {
    //     existingData = fs.readFileSync(fileName, "utf-8");
    //   }
    //   // Remove any previous entry for this tokenMint
    //   const lines = existingData.split("\n").filter((line) => !line.includes(`mint: ${tokenMint}`));
    //   // Add the new info for this tokenMint
    //   const infoText = `[${utcNow()}] mint: ${tokenMint}\n👥Holders: ${
    //     holders.length
    //   }  |  🐋Top10Percentage: ${top10Percentage}    |    Liquidity: ${liquidity}\n`;
    //   lines.push(infoText.trim());
    //   if (!fs.existsSync(walletDir)) {
    //     fs.mkdirSync(walletDir, { recursive: true });
    //   }
    //   fs.writeFileSync(fileName, lines.join("\n").trim() + "\n", { flag: "w" });
    // } catch (e) {
    //   console.error(`[${utcNow()}] Error saving token info for ${user}:`, e);
    // }

    const passed =
      holders.length > BUY_FILTER.minHolders &&
      holders.length < BUY_FILTER.maxHolders &&
      top10Percentage < BUY_FILTER.maxTop10Percentage &&
      liquidity > BUY_FILTER.minLiquidity &&
      liquidity < BUY_FILTER.maxLiquidity;

    if (passed) console.log(`[${utcNow()}] ✅ shouldBuy: TRUE for ${tokenMint}`);
    else console.log(`[${utcNow()}] ❌ shouldBuy: FALSE for ${tokenMint}`);
    return passed;
  }


  // Method to disable buying due to insufficient funds
  disableBuying() {
    this.buyingDisabled = true;
    console.log(chalk.cyan(`[${utcNow()}] ⚠️ Buying disabled due to insufficient funds`));
    console.log(chalk.cyan(`[${utcNow()}] 🔄 Bot will continue running for selling existing positions`));
  }


  handleError(error) {
    console.error(`[${utcNow()}] Stream Error1:`, error);
    this.isRunning = false;
  }
}

// Add global function to show all bot counts
export function showAllBotCounts() {
  console.log(chalk.bgCyan.black(`[${utcNow()}] 🤖 GLOBAL BOT STATUS REPORT`));
  console.log(chalk.cyan(`[${utcNow()}] Total monitors: ${TARGET_WALLET.length}`));

  // Note: This would need access to monitor instances
  // For now, we'll add this functionality to the main function
}

export async function pump_geyser() {
  const monitors = TARGET_WALLET.map((wallet) => new TransactionMonitor(wallet));

  console.log(`[${utcNow()}] 🚦 Script started for ${TARGET_WALLET.length} wallets`);
  console.log(chalk.blue(`[${utcNow()}] 💰 Balance limit set to: ${LIMIT_BALANCE} SOL`));
  console.log(chalk.blue(`[${utcNow()}] 📱 Insufficient funds alerts: ${ENABLE_INSUFFICIENT_FUNDS_ALERTS ? "✅ Enabled" : "❌ Disabled"}`));
  console.log(chalk.blue(`[${utcNow()}] ⏱️ Alert cooldown: ${INSUFFICIENT_FUNDS_ALERT_COOLDOWN / 60000} minutes`));
  // Show initial cache status
  showAllCacheStatus();

  // Initialize global blockhash manager
  console.log(chalk.bgCyan.black(`[${utcNow()}] 🔄 BLOCKHASH MANAGEMENT`));
  try {
    await globalBlockhashManager.initialize();
    console.log(chalk.green(`[${utcNow()}] ✅ Global blockhash manager initialized`));
    console.log(chalk.cyan(`[${utcNow()}] 🔄 Blockhash updates every 200ms in background`));
  } catch (error) {
    console.error(chalk.red(`[${utcNow()}] ❌ Failed to initialize global blockhash manager:`, error.message));
  }


  // Start bought tokens cache cleanup
  startBoughtTokensCleanup();
  
  // Start position tracking cleanup
  startPositionCleanup();

  // Add clear wallet configuration logging
  console.log(chalk.bgCyan.black(`[${utcNow()}] 🏠 WALLET CONFIGURATION`));
  console.log(chalk.cyan(`[${utcNow()}] MY_WALLET: ${MY_WALLET} (Your wallet - starts trading bots for monitoring/selling)`));
  TARGET_WALLET.forEach((wallet, index) => {
    console.log(chalk.cyan(`[${utcNow()}]   ${index + 1}. ${wallet}`));
  });
  console.log(chalk.bgCyan.black(`[${utcNow()}] 📊 TRANSACTION LOGIC`));
  console.log(chalk.cyan(`[${utcNow()}] 🏠 MY_WALLET transactions → Start trading bots to monitor and sell tokens`));

  // Function to start all monitors
  const startAllMonitors = async () => {
    try {
      await Promise.all(monitors.map((monitor) => monitor.start()));
      console.log(chalk.green(`[${utcNow()}] ✅ All monitors started successfully`));
      // updateBotRunningState(true);
    } catch (error) {
      console.error(chalk.red(`[${utcNow()}] ❌ Error starting monitors:`, error));
      // updateBotRunningState(false);
    }
  };

  // Function to stop all monitors
  const stopAllMonitors = async () => {
    try {
      await Promise.all(monitors.map((monitor) => monitor.stop()));
      console.log(chalk.green(`[${utcNow()}] ✅ All monitors stopped successfully`));
      // updateBotRunningState(false);
    } catch (error) {
      console.error(chalk.red(`[${utcNow()}] ❌ Error stopping monitors:`, error));
    }
  };

  // Initialize Telegram controller with monitors and control functions
  // setBotState({
  //   monitors,
  //   startFunction: startAllMonitors,
  //   stopFunction: stopAllMonitors,
  // });

  // Initial balance check before starting
  console.log(chalk.blue(`[${utcNow()}] 🔍 Performing initial balance check...`));
  try {
    const initialBalanceInfo = await checkWalletBalance();
    console.log(chalk.green(`[${utcNow()}] ✅ Initial balance: ${initialBalanceInfo.balance.toFixed(4)} SOL`));

    // Calculate recommended minimum balance for trading
    const buyAmountFloat = parseFloat(buyAmount) || 0.1;
    
    // Calculate maximum possible buy amount (fixed vs dynamic)
    let maxBuyAmount = buyAmountFloat;
    if (BUY_AMOUNT_PERCENTAGE !== null) {
      // If using percentage-based buying, estimate max amount based on typical target wallet behavior
      // Assume target wallets might spend up to 5 SOL per transaction as a reasonable upper bound
      const estimatedMaxTargetAmount = 5.0; // SOL
      const maxDynamicAmount = estimatedMaxTargetAmount * BUY_AMOUNT_PERCENTAGE;
      maxBuyAmount = Math.max(buyAmountFloat, maxDynamicAmount);
    }
    
    const recommendedMinBalance = maxBuyAmount + 5; // Max buy amount + buffer for fees

    console.log(chalk.blue(`[${utcNow()}] 💰 Fixed buy amount: ${buyAmountFloat} SOL`));
    if (BUY_AMOUNT_PERCENTAGE !== null) {
      console.log(chalk.blue(`[${utcNow()}] 💰 Dynamic buy percentage: ${(BUY_AMOUNT_PERCENTAGE * 100).toFixed(1)}% of target wallet's SOL change`));
      console.log(chalk.blue(`[${utcNow()}] 💰 Estimated max dynamic amount: ${maxBuyAmount.toFixed(4)} SOL`));
    }
    console.log(chalk.blue(`[${utcNow()}] 💰 Recommended minimum: ${recommendedMinBalance.toFixed(4)} SOL`));
    console.log(chalk.blue(`[${utcNow()}] 💰 Safety limit: ${LIMIT_BALANCE} SOL`));

    // Check if initial balance is sufficient for trading
    if (initialBalanceInfo.balance < LIMIT_BALANCE) {
      console.error(chalk.red(`[${utcNow()}] ❌ INSUFFICIENT INITIAL BALANCE: ${initialBalanceInfo.balance.toFixed(4)} SOL`));
      console.error(chalk.red(`[${utcNow()}] ❌ Required minimum: ${LIMIT_BALANCE} SOL`));
      console.error(chalk.red(`[${utcNow()}] ❌ Recommended minimum: ${recommendedMinBalance.toFixed(4)} SOL`));
      console.error(chalk.red(`[${utcNow()}] ❌ Please add SOL to your wallet before starting the bot`));

      // Send Telegram notification for insufficient initial balance (only once at startup, if alerts are enabled)
      if (ENABLE_INSUFFICIENT_FUNDS_ALERTS) {
        try {
          // await sendInsufficientFundsAlert({
          //   currentBalance: initialBalanceInfo.balance,
          //   limitBalance: LIMIT_BALANCE,
          //   walletAddress: initialBalanceInfo.publicKey,
          // });
          console.log(chalk.cyan(`[${utcNow()}] 📱 Initial insufficient funds alert sent`));
        } catch (telegramError) {
          console.error(chalk.red(`[${utcNow()}] ❌ Failed to send Telegram notification: ${telegramError.message}`));
        }
      } else {
        console.log(chalk.cyan(`[${utcNow()}] ⏳ Initial insufficient funds alert disabled via ENABLE_INSUFFICIENT_FUNDS_ALERTS=false`));
      }

      process.exit(1); // Exit with error code
    }

    // Show balance status
    if (initialBalanceInfo.balance >= recommendedMinBalance) {
      console.log(chalk.green(`[${utcNow()}] ✅ Initial balance check passed - sufficient funds for trading`));
      console.log(chalk.green(`[${utcNow()}] ✅ Can perform ${Math.floor(initialBalanceInfo.balance / maxBuyAmount)} buy transactions (based on max amount)`));
    } else {
      console.log(chalk.cyan(`[${utcNow()}] ⚠️ Initial balance check passed - but balance is low`));
      console.log(chalk.cyan(`[${utcNow()}] ⚠️ Consider adding more SOL for better trading capacity`));
    }
  } catch (balanceError) {
    console.error(chalk.red(`[${utcNow()}] ❌ Failed to check initial balance: ${balanceError.message}`));
    console.error(chalk.red(`[${utcNow()}] ❌ Cannot start bot without balance verification`));
    process.exit(1); // Exit with error code
  }

  // Add event listeners for insufficient funds (now handled per monitor)
  monitors.forEach((monitor) => {
    monitor.on("insufficientFunds", async (data) => {
      console.error(chalk.red(`[${utcNow()}] ⚠️ INSUFFICIENT FUNDS EVENT from monitor ${data.monitor.targetWallet.slice(0, 8)}...`));
      console.error(chalk.red(`[${utcNow()}] ⚠️ Buying disabled for this monitor - selling continues`));
    });
  });

  // Add manual status check every 60 seconds
  const globalStatusInterval = setInterval(() => {
    let totalBots = 0;
    let disabledMonitors = 0;
    for (const monitor of monitors) {
      totalBots += monitor.getRunningBotCount();
      if (monitor.buyingDisabled) disabledMonitors++;
    }
    const buyingStatus = disabledMonitors > 0 ? ` (${disabledMonitors} monitors with buying disabled)` : "";
    console.log(
      chalk.bgBlue.white(
        `[${utcNow()}] 🌐 GLOBAL STATUS: ${totalBots} total bots running across ${monitors.length} monitors${buyingStatus}`
      )
    );
  }, 60000); // Every 60 seconds

  // Add manual trigger for immediate status check
  process.on("SIGUSR1", () => {
    console.log(chalk.bgYellow.black(`[${utcNow()}] 📊 MANUAL STATUS TRIGGER`));
    let totalBots = 0;
    let disabledMonitors = 0;
    for (const monitor of monitors) {
      const botCount = monitor.getRunningBotCount();
      totalBots += botCount;
      if (monitor.buyingDisabled) disabledMonitors++;
      // console.log(chalk.cyan(`[${utcNow()}] Monitor ${monitor.targetWallet.slice(0, 8)}...: ${botCount} bots`));
      monitor.showBotStatus();
    }
    const buyingStatus = disabledMonitors > 0 ? ` (${disabledMonitors} monitors with buying disabled)` : "";
    console.log(chalk.bgGreen.black(`[${utcNow()}] 📈 TOTAL: ${totalBots} bots across all monitors${buyingStatus}`));
  });


  // Add manual trigger for strategy debug
  process.on("SIGUSR3", () => {
    console.log(chalk.bgMagenta.black(`[${utcNow()}] 🔍 MANUAL STRATEGY DEBUG TRIGGER`));
    for (const monitor of monitors) {
      monitor.logAllBotsDebugInfo();
    }
  });

  

  // Add manual trigger for position tracking status
  process.on("SIGUSR7", () => {
    console.log(chalk.bgMagenta.black(`[${utcNow()}] 📊 MANUAL POSITION TRACKING STATUS TRIGGER`));
    showPositionTrackingStatus();
  });

  // Add manual trigger for blockhash manager status
  process.on("SIGUSR6", async () => {
    console.log(chalk.bgCyan.black(`[${utcNow()}] 🔄 MANUAL BLOCKHASH MANAGER STATUS TRIGGER`));
    try {
      await globalBlockhashManager.healthCheck();
    } catch (error) {
      console.error(chalk.red(`[${utcNow()}] ❌ Error checking blockhash manager status:`, error.message));
    }
  });


  console.log(chalk.green(`[${utcNow()}] 💡 Send SIGUSR1 signal to see detailed bot status`));
  console.log(chalk.green(`[${utcNow()}] 💡 Send SIGUSR3 signal to debug all bot strategies`));
  console.log(chalk.green(`[${utcNow()}] 💡 Send SIGUSR6 signal to show blockhash manager status`));
  console.log(chalk.green(`[${utcNow()}] 💡 Send SIGUSR7 signal to show position tracking status`));
  console.log(chalk.green(`[${utcNow()}] 💡 Use Telegram bot to control start/stop remotely`));

  // Export functions for Telegram controller
  global.startTradingBot = startAllMonitors;
  global.stopTradingBot = stopAllMonitors;

  try {
    // Start monitors initially
    await startAllMonitors();
    // updateBotRunningState(true);
  } catch (error) {
    console.error(chalk.red(`[${utcNow()}] Error in pump_geyser:`, error));
    // updateBotRunningState(false);
  } finally {
    clearInterval(globalStatusInterval);
    
    // Cleanup position tracking
    if (positionCleanupInterval) {
      clearInterval(positionCleanupInterval);
      positionCleanupInterval = null;
      console.log(chalk.green(`[${utcNow()}] ✅ Position tracking cleanup stopped`));
    }
    
    // Cleanup global blockhash manager
    try {
      globalBlockhashManager.stopAll();
      console.log(chalk.green(`[${utcNow()}] ✅ Global blockhash manager stopped`));
    } catch (error) {
      console.error(chalk.red(`[${utcNow()}] ❌ Error stopping global blockhash manager:`, error.message));
    }
  }
}

function cleanupExpiredBoughtTokens() {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [tokenMint, data] of boughtTokensCache.entries()) {
    if (now - data.lastUpdate > BOUGHT_TOKENS_CACHE_DURATION) {
      boughtTokensCache.delete(tokenMint);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log(chalk.cyan(`[${utcNow()}] 🧹 Cleaned up ${cleanedCount} expired bought tokens from cache`));
  }
}

function startBoughtTokensCleanup() {
  if (boughtTokensCleanupInterval) {
    clearInterval(boughtTokensCleanupInterval);
  }
  
  // Clean up expired tokens every hour
  boughtTokensCleanupInterval = setInterval(cleanupExpiredBoughtTokens, 60 * 60 * 1000);
  
  // Initial cleanup
  cleanupExpiredBoughtTokens();
}


function showBoughtTokensStatus() {
  const totalTokens = boughtTokensCache.size;
  const totalValue = Array.from(boughtTokensCache.values()).reduce((sum, token) => sum + (token.amount * token.buyPrice), 0);
  
  console.log(chalk.cyan(`[${utcNow()}] 💰 Bought tokens cache status: ${totalTokens} tokens | Total value: ${totalValue.toFixed(6)} SOL`));
  
  if (totalTokens > 0) {
    console.log(chalk.cyan(`[${utcNow()}] 💰 Cached bought tokens:`));
    boughtTokensCache.forEach((data, tokenMint) => {
      const shortMint = tokenMint.slice(0, 8) + "..." + tokenMint.slice(-4);
      const age = Math.floor((Date.now() - data.buyTime) / 1000);
      console.log(chalk.cyan(`[${utcNow()}]   ${shortMint} | Amount: ${(data.amount || 0).toLocaleString()} | Price: ${data.buyPrice} | Age: ${age}s`));
    });
  }
}

function showAllCacheStatus() {
  console.log(chalk.bgCyan.black(`[${utcNow()}] 📊 CACHE STATUS OVERVIEW`));
  
  // Show bought tokens cache status
  showBoughtTokensStatus();
  
  // Show position tracking status
  showPositionTrackingStatus();
}

// Position tracking management functions for per-wallet copy trading
function addPosition(tokenMint, targetWallet, targetBoughtAmount, ourBoughtAmount) {
  const now = Date.now();
  
  // Initialize token map if it doesn't exist
  if (!positions.has(tokenMint)) {
    positions.set(tokenMint, new Map());
  }
  
  const tokenPositions = positions.get(tokenMint);
  
  // Get existing position or create new one
  let position = tokenPositions.get(targetWallet);
  if (!position) {
    position = {
      purchases: [],
      totalAmount: 0
    };
  }
  
  // Add new purchase with exact amounts
  const purchase = {
    targetBoughtAmount: targetBoughtAmount || 0,
    ourBoughtAmount: ourBoughtAmount || 0,
    buyTime: now,
    lastUpdate: now
  };
  
  position.purchases.push(purchase);
  position.totalAmount += (ourBoughtAmount || 0);
  position.lastUpdate = now;
  
  tokenPositions.set(targetWallet, position);
  
  // Update global purchase count for this token
  updateTokenPurchaseCount(tokenMint, 1); // Add 1 purchase
  
  console.log(chalk.green(`[${utcNow()}] 📈 Position added: ${tokenMint.slice(0, 8)}... | Wallet: ${targetWallet.slice(0, 8)}... | Target: ${(targetBoughtAmount || 0).toLocaleString()} | Our: ${(ourBoughtAmount || 0).toLocaleString()} | Total: ${(position.totalAmount || 0).toLocaleString()}`));
}

// Global purchase count management functions
function updateTokenPurchaseCount(tokenMint, delta) {
  const now = Date.now();
  
  let countData = tokenPurchaseCounts.get(tokenMint);
  if (!countData) {
    countData = {
      totalPurchases: 0,
      remainingPurchases: 0,
      lastUpdate: now
    };
  }
  
  countData.totalPurchases += delta;
  countData.remainingPurchases += delta;
  countData.lastUpdate = now;
  
  tokenPurchaseCounts.set(tokenMint, countData);
  
  console.log(chalk.cyan(`[${utcNow()}] 📊 Purchase count updated: ${tokenMint.slice(0, 8)}... | Total: ${countData.totalPurchases} | Remaining: ${countData.remainingPurchases}`));
}

function getTokenPurchaseCount(tokenMint) {
  return tokenPurchaseCounts.get(tokenMint) || { totalPurchases: 0, remainingPurchases: 0, lastUpdate: 0 };
}

function isLastRemainingPurchase(tokenMint) {
  const countData = getTokenPurchaseCount(tokenMint);
  return countData.remainingPurchases === 1;
}

function getRemainingPurchaseCount(tokenMint) {
  const countData = getTokenPurchaseCount(tokenMint);
  return countData.remainingPurchases;
}

function getPosition(tokenMint, targetWallet) {
  const tokenPositions = positions.get(tokenMint);
  if (!tokenPositions) return null;
  
  const position = tokenPositions.get(targetWallet);
  if (position) {
    // Update last access time
    position.lastUpdate = Date.now();
  }
  return position;
}

// New function to get exact sell amount based on target wallet's sell amount
function getExactSellAmount(tokenMint, targetWallet, targetSellAmount) {
  const position = getPosition(tokenMint, targetWallet);
  if (!position || !position.purchases || position.purchases.length === 0) {
    return null;
  }
  
  // Find matching purchase based on target sell amount
  // Look for exact match first
  let matchingPurchase = position.purchases.find(p => p.targetBoughtAmount === targetSellAmount);
  
  if (matchingPurchase) {
    // Exact match found, return our corresponding amount
    return {
      ourSellAmount: matchingPurchase.ourBoughtAmount,
      purchase: matchingPurchase
    };
  }
  
  // If no exact match, find the closest match (for partial sells)
  // Sort purchases by target amount to find the best match
  const sortedPurchases = [...position.purchases].sort((a, b) => Math.abs(a.targetBoughtAmount - targetSellAmount) - Math.abs(b.targetBoughtAmount - targetSellAmount));
  
  if (sortedPurchases.length > 0) {
    const closestPurchase = sortedPurchases[0];
    // Calculate proportional amount based on the closest match
    const ratio = targetSellAmount / closestPurchase.targetBoughtAmount;
    const ourSellAmount = Math.floor(closestPurchase.ourBoughtAmount * ratio);
    
    return {
      ourSellAmount: ourSellAmount,
      purchase: closestPurchase,
      isProportional: true
    };
  }
  
  return null;
}

function removePosition(tokenMint, targetWallet) {
  const tokenPositions = positions.get(tokenMint);
  if (!tokenPositions) return false;
  
  const removed = tokenPositions.delete(targetWallet);
  if (removed) {
    console.log(chalk.yellow(`[${utcNow()}] 🗑️ Position removed: ${tokenMint.slice(0, 8)}... | Wallet: ${targetWallet.slice(0, 8)}...`));
    
    // Clean up empty token map
    if (tokenPositions.size === 0) {
      positions.delete(tokenMint);
    }
  }
  return removed;
}

// New function to remove specific purchase after selling
function removePurchase(tokenMint, targetWallet, targetSellAmount) {
  const position = getPosition(tokenMint, targetWallet);
  if (!position || !position.purchases) return false;
  
  // Find and remove the matching purchase
  const purchaseIndex = position.purchases.findIndex(p => p.targetBoughtAmount === targetSellAmount);
  
  if (purchaseIndex !== -1) {
    const removedPurchase = position.purchases.splice(purchaseIndex, 1)[0];
    position.totalAmount -= removedPurchase.ourBoughtAmount;
    position.lastUpdate = Date.now();
    
    // Decrement remaining purchase count
    updateTokenPurchaseCount(tokenMint, -1); // Subtract 1 purchase
    
    console.log(chalk.yellow(`[${utcNow()}] 🗑️ Purchase removed: ${tokenMint.slice(0, 8)}... | Wallet: ${targetWallet.slice(0, 8)}... | Target: ${(targetSellAmount || 0).toLocaleString()} | Our: ${(removedPurchase.ourBoughtAmount || 0).toLocaleString()}`));
    
    // If no more purchases, remove the entire position
    if (position.purchases.length === 0) {
      removePosition(tokenMint, targetWallet);
    }
    
    return true;
  }
  
  return false;
}

function getAllPositions() {
  const allPositions = [];
  for (const [tokenMint, tokenPositions] of positions.entries()) {
    for (const [targetWallet, positionData] of tokenPositions.entries()) {
      allPositions.push({
        tokenMint,
        targetWallet,
        totalAmount: positionData.totalAmount,
        purchaseCount: positionData.purchases.length,
        lastUpdate: positionData.lastUpdate
      });
    }
  }
  return allPositions;
}

function getPositionsByToken(tokenMint) {
  const tokenPositions = positions.get(tokenMint);
  if (!tokenPositions) return [];
  
  return Array.from(tokenPositions.entries()).map(([targetWallet, positionData]) => ({
    targetWallet,
    totalAmount: positionData.totalAmount,
    purchaseCount: positionData.purchases.length,
    lastUpdate: positionData.lastUpdate
  }));
}

function getPositionsByWallet(targetWallet) {
  const walletPositions = [];
  for (const [tokenMint, tokenPositions] of positions.entries()) {
    const position = tokenPositions.get(targetWallet);
    if (position) {
      walletPositions.push({
        tokenMint,
        totalAmount: position.totalAmount,
        purchaseCount: position.purchases.length,
        lastUpdate: position.lastUpdate
      });
    }
  }
  return walletPositions;
}

function cleanupExpiredPositions() {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [tokenMint, tokenPositions] of positions.entries()) {
    for (const [targetWallet, positionData] of tokenPositions.entries()) {
      if (now - positionData.lastUpdate > POSITION_CACHE_DURATION) {
        tokenPositions.delete(targetWallet);
        cleanedCount++;
      }
    }
    
    // Clean up empty token maps
    if (tokenPositions.size === 0) {
      positions.delete(tokenMint);
      // Also clean up purchase count data for this token
      tokenPurchaseCounts.delete(tokenMint);
    }
  }
  
  // Clean up expired purchase count data
  for (const [tokenMint, countData] of tokenPurchaseCounts.entries()) {
    if (now - countData.lastUpdate > POSITION_CACHE_DURATION) {
      tokenPurchaseCounts.delete(tokenMint);
    }
  }
  
  if (cleanedCount > 0) {
    console.log(chalk.cyan(`[${utcNow()}] 🧹 Cleaned up ${cleanedCount} expired positions from cache`));
  }
}

function startPositionCleanup() {
  if (positionCleanupInterval) {
    clearInterval(positionCleanupInterval);
  }
  
  // Clean up expired positions every hour
  positionCleanupInterval = setInterval(cleanupExpiredPositions, 60 * 60 * 1000);
  
  // Initial cleanup
  cleanupExpiredPositions();
}

function showPositionTrackingStatus() {
  const totalTokens = positions.size;
  let totalPositions = 0;
  let totalPurchases = 0;
  let totalValue = 0;
  
  for (const [tokenMint, tokenPositions] of positions.entries()) {
    totalPositions += tokenPositions.size;
    for (const [targetWallet, positionData] of tokenPositions.entries()) {
      totalPurchases += positionData.purchases.length;
      totalValue += positionData.totalAmount;
    }
  }
  
  console.log(chalk.cyan(`[${utcNow()}] 📊 Position tracking status: ${totalPositions} positions (${totalPurchases} purchases) across ${totalTokens} tokens | Total value: ${totalValue.toFixed(6)} tokens`));
  
  if (totalPositions > 0) {
    console.log(chalk.cyan(`[${utcNow()}] 📊 Active positions:`));
    for (const [tokenMint, tokenPositions] of positions.entries()) {
      const shortMint = tokenMint.slice(0, 8) + "..." + tokenMint.slice(-4);
      const purchaseCount = getTokenPurchaseCount(tokenMint);
      console.log(chalk.cyan(`[${utcNow()}]   ${shortMint} (Total: ${purchaseCount.totalPurchases} purchases, Remaining: ${purchaseCount.remainingPurchases}):`));
      
      for (const [targetWallet, positionData] of tokenPositions.entries()) {
        const shortWallet = targetWallet.slice(0, 8) + "..." + targetWallet.slice(-4);
        const age = Math.floor((Date.now() - positionData.lastUpdate) / 1000);
        console.log(chalk.cyan(`[${utcNow()}]     • ${shortWallet} | Total: ${(positionData.totalAmount || 0).toLocaleString()} | Purchases: ${positionData.purchases.length} | Age: ${age}s`));
        
        // Show individual purchases
        positionData.purchases.forEach((purchase, index) => {
          const purchaseAge = Math.floor((Date.now() - purchase.buyTime) / 1000);
          console.log(chalk.cyan(`[${utcNow()}]       - Purchase ${index + 1}: Target ${(purchase.targetBoughtAmount || 0).toLocaleString()} | Our ${(purchase.ourBoughtAmount || 0).toLocaleString()} | Age: ${purchaseAge}s`));
        });
      }
    }
  }
}

// Helper function to calculate dynamic buy amount based on percentage of target wallet's SOL change
function calculateDynamicBuyAmount(solChanges,BUY_AMOUNT_PERCENTAGE ) {
  // If BUY_AMOUNT_PERCENTAGE is not set, return null to use fixed amount
  if (BUY_AMOUNT_PERCENTAGE === null) {
    return null;
  }

  try {
    // Calculate the percentage-based amount
    const solChangesInSol = Math.abs(solChanges) / LAMPORTS_PER_SOL;
    const dynamicAmount = solChangesInSol * BUY_AMOUNT_PERCENTAGE;
    
   
    
    const clampedAmount = Math.max(minAmount, Math.min(maxAmount, dynamicAmount));

    // console.log(chalk.cyan(`[${utcNow()}] 💰 Dynamic Buy Amount Calculation:`));
    // console.log(chalk.cyan(`   • Target SOL Change: ${solChangesInSol.toFixed(4)} SOL`));
    // console.log(chalk.cyan(`   • Percentage: ${(BUY_AMOUNT_PERCENTAGE * 100).toFixed(1)}%`));
    // console.log(chalk.cyan(`   • Calculated Amount: ${dynamicAmount.toFixed(4)} SOL`));
    // console.log(chalk.cyan(`   • Final Amount (clamped): ${clampedAmount.toFixed(4)} SOL`));
    
    return clampedAmount;
  } catch (error) {
    console.error(chalk.red(`[${utcNow()}] ❌ Error calculating dynamic buy amount: ${error.message}`));
    return null; // Fall back to fixed amount
  }
}

// Add global function to show all bot counts
