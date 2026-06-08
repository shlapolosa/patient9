/**
 * Real-time Service Discovery Loop
 * Continuously monitors Kubernetes services and updates GraphQL Mesh configuration
 */

const ServiceDiscovery = require('./service-discovery');
const MeshManager = require('./mesh-manager');

class DiscoveryLoop {
  constructor(options = {}) {
    this.namespace = options.namespace || 'default';
    this.labelSelector = options.labelSelector || 'app.kubernetes.io/managed-by=kubevela';
    this.interval = this.parseInterval(options.interval || '5m');
    this.retryDelay = this.parseInterval(options.retryDelay || '30s');
    this.maxRetries = options.maxRetries || 3;
    
    this.serviceDiscovery = new ServiceDiscovery(this.namespace);
    this.meshManager = new MeshManager();
    
    this.isRunning = false;
    this.currentTimeout = null;
    this.retryCount = 0;
    this.lastSuccessfulRun = null;
    this.lastError = null;
    
    // Bind methods to ensure correct 'this' context
    this.discoveryTick = this.discoveryTick.bind(this);
    this.handleDiscoveryError = this.handleDiscoveryError.bind(this);
    
    console.log(`🔄 Discovery loop initialized - Namespace: ${this.namespace}, Interval: ${this.interval}ms`);
  }

  /**
   * Start the discovery loop
   * @returns {Promise<void>}
   */
  async start() {
    if (this.isRunning) {
      console.log('⚠️  Discovery loop is already running');
      return;
    }

    console.log('🚀 Starting service discovery loop...');
    this.isRunning = true;
    this.retryCount = 0;
    
    // Run initial discovery immediately
    await this.discoveryTick();
    
    // Schedule next run
    this.scheduleNext();
  }

  /**
   * Stop the discovery loop
   */
  async stop() {
    if (!this.isRunning) {
      console.log('⚠️  Discovery loop is not running');
      return;
    }

    console.log('⏹️  Stopping service discovery loop...');
    this.isRunning = false;
    
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
      this.currentTimeout = null;
    }
    
    // Cleanup mesh manager
    await this.meshManager.cleanup();
    
    console.log('✅ Discovery loop stopped');
  }

  /**
   * Single discovery tick - the main discovery logic
   */
  async discoveryTick() {
    if (!this.isRunning) {
      return;
    }

    const startTime = Date.now();
    console.log(`🔍 Discovery tick starting... (Attempt ${this.retryCount + 1}/${this.maxRetries + 1})`);

    try {
      // Step 1: Discover all services
      const allServices = await this.serviceDiscovery.discoverAllServices(this.labelSelector);
      console.log(`📊 Discovered ${allServices.length} services total`);

      // Step 2: Probe for OpenAPI specifications
      const servicesWithSpecs = await this.serviceDiscovery.probeOpenApiEndpoints(allServices);
      const specCount = servicesWithSpecs.filter(s => s.hasOpenApi).length;
      console.log(`📋 Found ${specCount} services with OpenAPI specifications`);

      // Step 3: Update GraphQL Mesh configuration
      const meshUpdated = await this.meshManager.updateConfiguration(servicesWithSpecs);
      
      if (meshUpdated) {
        console.log('🔄 GraphQL Mesh configuration updated');
      } else {
        console.log('📋 GraphQL Mesh configuration unchanged');
      }

      // Step 4: Log discovery summary
      const duration = Date.now() - startTime;
      console.log(`✅ Discovery completed in ${duration}ms - Services: ${allServices.length}, With APIs: ${specCount}`);
      
      // Reset retry count on success
      this.retryCount = 0;
      this.lastSuccessfulRun = new Date();
      this.lastError = null;
      
      // Schedule next discovery
      this.scheduleNext();
      
    } catch (error) {
      await this.handleDiscoveryError(error, startTime);
    }
  }

  /**
   * Handle discovery errors with retry logic
   * @param {Error} error - The error that occurred
   * @param {number} startTime - When the discovery attempt started
   */
  async handleDiscoveryError(error, startTime) {
    const duration = Date.now() - startTime;
    this.retryCount++;
    this.lastError = {
      message: error.message,
      timestamp: new Date(),
      attempt: this.retryCount
    };

    console.error(`❌ Discovery failed (${duration}ms) - Attempt ${this.retryCount}/${this.maxRetries + 1}: ${error.message}`);

    if (this.retryCount <= this.maxRetries) {
      // Schedule retry with exponential backoff
      const retryDelay = this.retryDelay * Math.pow(2, this.retryCount - 1);
      console.log(`🔄 Retrying discovery in ${retryDelay}ms...`);
      
      this.currentTimeout = setTimeout(this.discoveryTick, retryDelay);
    } else {
      // Max retries exceeded - reset and schedule next regular interval
      console.error(`💥 Max retries (${this.maxRetries}) exceeded. Will retry on next scheduled interval.`);
      this.retryCount = 0;
      this.scheduleNext();
    }
  }

  /**
   * Schedule the next discovery run
   */
  scheduleNext() {
    if (!this.isRunning) {
      return;
    }

    this.currentTimeout = setTimeout(this.discoveryTick, this.interval);
    const nextRun = new Date(Date.now() + this.interval);
    console.log(`⏰ Next discovery scheduled for ${nextRun.toISOString()}`);
  }

  /**
   * Parse interval string to milliseconds
   * @param {string} intervalStr - Interval string (e.g., '5m', '30s', '1h')
   * @returns {number} Interval in milliseconds
   */
  parseInterval(intervalStr) {
    const units = {
      'ms': 1,
      's': 1000,
      'm': 60 * 1000,
      'h': 60 * 60 * 1000,
      'd': 24 * 60 * 60 * 1000
    };

    const match = intervalStr.match(/^(\d+)([a-z]+)$/i);
    if (!match) {
      throw new Error(`Invalid interval format: ${intervalStr}. Use format like '5m', '30s', '1h'`);
    }

    const [, value, unit] = match;
    const multiplier = units[unit.toLowerCase()];
    
    if (!multiplier) {
      throw new Error(`Unknown time unit: ${unit}. Supported: ms, s, m, h, d`);
    }

    return parseInt(value) * multiplier;
  }

  /**
   * Get current status of the discovery loop
   * @returns {Object} Status information
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      namespace: this.namespace,
      labelSelector: this.labelSelector,
      interval: this.interval,
      retryDelay: this.retryDelay,
      maxRetries: this.maxRetries,
      currentRetryCount: this.retryCount,
      lastSuccessfulRun: this.lastSuccessfulRun,
      lastError: this.lastError,
      nextScheduledRun: this.currentTimeout ? new Date(Date.now() + this.interval) : null,
      meshStatus: this.meshManager.getHealthStatus(),
      serviceStats: this.meshManager.getStats()
    };
  }

  /**
   * Force an immediate discovery run (outside of scheduled interval)
   * @returns {Promise<void>}
   */
  async forceDiscovery() {
    console.log('🚀 Forcing immediate discovery run...');
    
    // Cancel current timeout if exists
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
      this.currentTimeout = null;
    }
    
    // Reset retry count for forced run
    const originalRetryCount = this.retryCount;
    this.retryCount = 0;
    
    try {
      await this.discoveryTick();
    } catch (error) {
      // Restore original retry count if forced run fails
      this.retryCount = originalRetryCount;
      throw error;
    }
  }

  /**
   * Update discovery loop configuration
   * @param {Object} newOptions - New configuration options
   */
  updateConfig(newOptions) {
    console.log('⚙️  Updating discovery loop configuration...');
    
    if (newOptions.interval) {
      this.interval = this.parseInterval(newOptions.interval);
      console.log(`  📅 Interval updated to: ${this.interval}ms`);
    }
    
    if (newOptions.labelSelector) {
      this.labelSelector = newOptions.labelSelector;
      console.log(`  🏷️  Label selector updated to: ${this.labelSelector}`);
    }
    
    if (newOptions.retryDelay) {
      this.retryDelay = this.parseInterval(newOptions.retryDelay);
      console.log(`  ⏰ Retry delay updated to: ${this.retryDelay}ms`);
    }
    
    if (newOptions.maxRetries !== undefined) {
      this.maxRetries = newOptions.maxRetries;
      console.log(`  🔄 Max retries updated to: ${this.maxRetries}`);
    }
    
    // If running, reschedule with new interval
    if (this.isRunning && this.currentTimeout) {
      clearTimeout(this.currentTimeout);
      this.scheduleNext();
    }
  }

  /**
   * Get detailed metrics for monitoring
   * @returns {Object} Detailed metrics
   */
  getMetrics() {
    const status = this.getStatus();
    const meshStats = this.meshManager.getStats();
    
    return {
      // Discovery loop metrics
      discovery: {
        isRunning: status.isRunning,
        uptime: status.lastSuccessfulRun ? Date.now() - status.lastSuccessfulRun.getTime() : null,
        totalRetries: status.currentRetryCount,
        lastErrorTime: status.lastError?.timestamp,
        successRate: status.lastError ? 0 : 1, // Simplified - could track over time
      },
      
      // Service discovery metrics
      services: {
        totalDiscovered: meshStats.servicesCount,
        withOpenApi: Array.from(this.meshManager.currentServices.values()).filter(s => s.hasOpenApi).length,
        serviceNames: meshStats.services
      },
      
      // Mesh metrics
      mesh: {
        configured: meshStats.meshConfigured,
        configPath: meshStats.configPath,
        lastUpdate: status.lastSuccessfulRun
      },
      
      // Configuration
      config: {
        namespace: this.namespace,
        labelSelector: this.labelSelector,
        interval: this.interval,
        retryDelay: this.retryDelay,
        maxRetries: this.maxRetries
      }
    };
  }
}

module.exports = DiscoveryLoop;