import { BlockhashManager } from './blockhash_manager.js';

// Global blockhash manager service for the entire application
class GlobalBlockhashManager {
  constructor() {
    this.managers = new Map(); // connection -> BlockhashManager
    this.defaultUpdateInterval = 200; // 200ms as requested
    this.isInitialized = false;
    this.globalStats = {
      totalManagers: 0,
      activeManagers: 0,
      totalUpdates: 0,
      totalErrors: 0
    };
  }

  // Initialize blockhash manager for a specific connection
  async initializeManager(connection, updateInterval = null) {
    const interval = updateInterval || this.defaultUpdateInterval;
    const connectionKey = this.getConnectionKey(connection);
    
    if (this.managers.has(connectionKey)) {
      console.log(`🔄 Blockhash manager already exists for connection ${connectionKey.slice(0, 8)}...`);
      return this.managers.get(connectionKey);
    }

    try {
      console.log(`🔄 Initializing blockhash manager for connection ${connectionKey.slice(0, 8)}... (${interval}ms updates)`);
      
      const manager = new BlockhashManager(connection, interval);
      await manager.start();
      
      this.managers.set(connectionKey, manager);
      this.globalStats.totalManagers++;
      this.globalStats.activeManagers++;
      
      console.log(`✅ Blockhash manager initialized successfully for connection ${connectionKey.slice(0, 8)}...`);
      
      // Set up cleanup when manager stops
      const originalStop = manager.stop.bind(manager);
      manager.stop = () => {
        originalStop();
        this.globalStats.activeManagers--;
        this.managers.delete(connectionKey);
        console.log(`🗑️ Blockhash manager cleaned up for connection ${connectionKey.slice(0, 8)}...`);
      };
      
      return manager;
    } catch (error) {
      console.error(`❌ Failed to initialize blockhash manager for connection ${connectionKey.slice(0, 8)}...:`, error.message);
      throw error;
    }
  }

  // Get or create blockhash manager for a connection
  async getManager(connection, updateInterval = null) {
    const connectionKey = this.getConnectionKey(connection);
    
    if (!this.managers.has(connectionKey)) {
      await this.initializeManager(connection, updateInterval);
    }
    
    return this.managers.get(connectionKey);
  }

  // Get blockhash manager for a connection (synchronous, returns existing manager)
  getManagerSync(connection) {
    const connectionKey = this.getConnectionKey(connection);
    return this.managers.get(connectionKey) || null;
  }

  // Get blockhash for a connection
  async getBlockhash(connection) {
    const manager = await this.getManager(connection);
    return manager.getBlockhash();
  }

  // Get blockhash synchronously for a connection
  getBlockhashSync(connection) {
    const manager = this.getManagerSync(connection);
    if (!manager) {
      console.warn("⚠️ No blockhash manager found for connection, please initialize first");
      return null;
    }
    return manager.getBlockhashSync();
  }

  // Get blockhash for trading operations
  getBlockhashForTrading(connection) {
    const manager = this.getManagerSync(connection);
    if (!manager) {
      console.warn("⚠️ No blockhash manager found for connection, please initialize first");
      return null;
    }
    return manager.getBlockhashForTrading();
  }

  // Get fresh blockhash for a connection
  async getFreshBlockhash(connection) {
    const manager = await this.getManager(connection);
    return manager.getFreshBlockhash();
  }

  // Get last valid block height for a connection
  getLastValidBlockHeight(connection) {
    const manager = this.getManagerSync(connection);
    if (!manager) return null;
    return manager.getLastValidBlockHeight();
  }

  // Force update for a specific connection
  async forceUpdate(connection) {
    const manager = await this.getManager(connection);
    return manager.forceUpdate();
  }

  // Stop all managers
  stopAll() {
    console.log("🛑 Stopping all blockhash managers...");
    for (const [connectionKey, manager] of this.managers.entries()) {
      try {
        manager.stop();
        console.log(`✅ Stopped blockhash manager for connection ${connectionKey.slice(0, 8)}...`);
      } catch (error) {
        console.error(`❌ Error stopping blockhash manager for connection ${connectionKey.slice(0, 8)}...:`, error.message);
      }
    }
    
    this.managers.clear();
    this.globalStats.activeManagers = 0;
    console.log("✅ All blockhash managers stopped");
  }

  // Get status of all managers
  getAllStatus() {
    const status = {
      global: { ...this.globalStats },
      managers: {}
    };
    
    for (const [connectionKey, manager] of this.managers.entries()) {
      status.managers[connectionKey.slice(0, 8) + "..."] = manager.getStatus();
    }
    
    return status;
  }

  // Get performance statistics
  getGlobalPerformanceStats() {
    const stats = { ...this.globalStats };
    
    let totalUpdates = 0;
    let totalSuccessful = 0;
    let totalFailed = 0;
    let totalUpdateTime = 0;
    
    for (const manager of this.managers.values()) {
      const managerStats = manager.getPerformanceStats();
      totalUpdates += managerStats.totalUpdates;
      totalSuccessful += managerStats.successfulUpdates;
      totalFailed += managerStats.failedUpdates;
      totalUpdateTime += managerStats.averageUpdateTime * managerStats.successfulUpdates;
    }
    
    stats.totalUpdates = totalUpdates;
    stats.totalSuccessful = totalSuccessful;
    stats.totalFailed = totalFailed;
    stats.globalSuccessRate = totalUpdates > 0 ? (totalSuccessful / totalUpdates * 100).toFixed(2) : 0;
    stats.averageUpdateTime = totalSuccessful > 0 ? (totalUpdateTime / totalSuccessful).toFixed(2) : 0;
    
    return stats;
  }

  // Health check for all managers
  async healthCheck() {
    console.log("🏥 Performing global blockhash manager health check...");
    
    const status = this.getAllStatus();
    const performance = this.getGlobalPerformanceStats();
    
    console.log(`📊 Global Status:`);
    console.log(`   • Total Managers: ${status.global.totalManagers}`);
    console.log(`   • Active Managers: ${status.global.activeManagers}`);
    console.log(`   • Total Updates: ${performance.totalUpdates}`);
    console.log(`   • Success Rate: ${performance.globalSuccessRate}%`);
    console.log(`   • Average Update Time: ${performance.averageUpdateTime}ms`);
    
    for (const [connectionKey, managerStatus] of Object.entries(status.managers)) {
      console.log(`📊 Manager ${connectionKey}:`);
      console.log(`   • Running: ${managerStatus.isRunning ? "✅" : "❌"}`);
      console.log(`   • Has Blockhash: ${managerStatus.hasBlockhash ? "✅" : "❌"}`);
      console.log(`   • Blockhash Age: ${managerStatus.blockhashAge} slots`);
      console.log(`   • Connection Health: ${managerStatus.connectionHealth ? "✅" : "❌"}`);
      console.log(`   • Fallbacks: ${managerStatus.fallbackCount}`);
      console.log(`   • Last Update: ${managerStatus.lastUpdate ? new Date(managerStatus.lastUpdate).toLocaleTimeString() : "Never"}`);
    }
    
    return { status, performance };
  }

  // Helper method to get a unique key for a connection
  getConnectionKey(connection) {
    // Use endpoint URL as connection identifier
    return connection._rpcEndpoint || connection._rpcEndpoint || 'unknown';
  }

  // Initialize with default settings
  async initialize() {
    if (this.isInitialized) return;
    
    console.log("🚀 Initializing Global Blockhash Manager Service...");
    console.log(`⚙️ Default update interval: ${this.defaultUpdateInterval}ms`);
    
    this.isInitialized = true;
    console.log("✅ Global Blockhash Manager Service initialized");
  }
}

// Create and export singleton instance
const globalBlockhashManager = new GlobalBlockhashManager();

// Export the singleton instance
export default globalBlockhashManager;

// Also export the class for testing or custom instances
export { GlobalBlockhashManager };
