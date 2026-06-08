#!/usr/bin/env node

/**
 * GraphQL Gateway - Main Entry Point
 * Production-ready GraphQL federation gateway for Kubernetes services
 */

const GatewayServer = require('./gateway-server');

// Configuration from environment variables
const config = {
  port: parseInt(process.env.GATEWAY_PORT || '8080'),
  host: process.env.HOST || '0.0.0.0',
  namespace: process.env.NAMESPACE || 'default',
  labelSelector: process.env.SERVICE_SELECTOR_LABELS || 'app.kubernetes.io/managed-by=kubevela',
  discoveryInterval: process.env.DISCOVERY_INTERVAL || '5m',
  autoDiscovery: process.env.AUTO_DISCOVERY !== 'false',
  exposePlayground: process.env.EXPOSE_PLAYGROUND !== 'false',
  exposeIntrospection: process.env.EXPOSE_INTROSPECTION === 'true',
  enableCors: process.env.ENABLE_CORS !== 'false'
};

async function main() {
  console.log('🚀 Starting GraphQL Gateway...');
  console.log('📋 Configuration:');
  console.log(`   Port: ${config.port}`);
  console.log(`   Host: ${config.host}`);
  console.log(`   Namespace: ${config.namespace}`);
  console.log(`   Label Selector: ${config.labelSelector}`);
  console.log(`   Discovery Interval: ${config.discoveryInterval}`);
  console.log(`   Auto Discovery: ${config.autoDiscovery}`);
  console.log(`   Expose Playground: ${config.exposePlayground}`);
  console.log(`   Expose Introspection: ${config.exposeIntrospection}`);
  console.log(`   Enable CORS: ${config.enableCors}`);
  console.log('');

  try {
    const gateway = new GatewayServer(config);
    await gateway.start();
  } catch (error) {
    console.error('💥 Failed to start GraphQL Gateway:', error);
    process.exit(1);
  }
}

// Handle command line arguments
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
GraphQL Gateway - Kubernetes Service Federation

USAGE:
  node index.js [options]

ENVIRONMENT VARIABLES:
  GATEWAY_PORT                 Port to listen on (default: 8080)
  HOST                        Host to bind to (default: 0.0.0.0)
  NAMESPACE                   Kubernetes namespace (default: default)
  SERVICE_SELECTOR_LABELS     Label selector for services (default: app.kubernetes.io/managed-by=kubevela)
  DISCOVERY_INTERVAL          Service discovery interval (default: 5m)
  AUTO_DISCOVERY              Enable auto discovery (default: true)
  EXPOSE_PLAYGROUND           Enable GraphQL Playground (default: true)
  EXPOSE_INTROSPECTION        Enable GraphQL introspection (default: false)
  ENABLE_CORS                 Enable CORS (default: true)
  NODE_ENV                    Environment (development|production)

EXAMPLES:
  # Start with default configuration
  node index.js

  # Start with custom namespace and interval
  NAMESPACE=production DISCOVERY_INTERVAL=10m node index.js

  # Production mode with security
  NODE_ENV=production EXPOSE_PLAYGROUND=false EXPOSE_INTROSPECTION=false node index.js
`);
    process.exit(0);
  }
  
  if (args.includes('--version') || args.includes('-v')) {
    const pkg = require('../package.json');
    console.log(`GraphQL Gateway v${pkg.version}`);
    process.exit(0);
  }
  
  // Start the server
  main().catch(error => {
    console.error('💥 Startup error:', error);
    process.exit(1);
  });
}

module.exports = { GatewayServer, config };