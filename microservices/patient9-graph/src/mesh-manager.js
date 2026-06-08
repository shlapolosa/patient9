/**
 * GraphQL Mesh Manager
 * Dynamically manages GraphQL Mesh configuration and schema federation
 */

const { getMesh } = require('@graphql-mesh/runtime');
const { processConfig } = require('@graphql-mesh/config');
const { join } = require('path');
const { writeFileSync, existsSync, mkdirSync } = require('fs');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const { stitchSchemas } = require('@graphql-tools/stitch');

class MeshManager {
  constructor() {
    this.mesh = null;
    this.currentServices = new Map();
    this.currentSchemas = new Map();
    this.configPath = join(__dirname, '../config');
    this.meshConfigPath = join(this.configPath, '.meshrc.yml');
    
    // Ensure config directory exists
    if (!existsSync(this.configPath)) {
      mkdirSync(this.configPath, { recursive: true });
    }
  }

  /**
   * Update mesh configuration with discovered services
   * @param {Array} discoveredServices - Array of services with OpenAPI specs
   * @returns {Promise<boolean>} True if configuration was updated and mesh rebuilt
   */
  async updateConfiguration(discoveredServices) {
    try {
      console.log(`🔧 Updating GraphQL Mesh configuration with ${discoveredServices.length} services`);
      
      // Filter services that have OpenAPI specs
      const servicesWithSpecs = discoveredServices.filter(service => 
        service.hasOpenApi && service.openApiSpec
      );
      
      if (servicesWithSpecs.length === 0) {
        console.log('⚠️  No services with OpenAPI specs found, using fallback configuration');
        return await this.createFallbackConfiguration();
      }
      
      // Check if services have changed
      const servicesChanged = this.hasServicesChanged(servicesWithSpecs);
      if (!servicesChanged) {
        console.log('📋 Services haven\'t changed, keeping current mesh configuration');
        return false;
      }
      
      // Generate new mesh configuration
      const meshConfig = this.generateMeshConfig(servicesWithSpecs);
      
      // Write mesh configuration file (debuggability only; not read back)
      this.writeMeshConfig(meshConfig);

      // Rebuild mesh with the in-memory configuration
      const success = await this.rebuildMesh(meshConfig);
      
      if (success) {
        // Update our service tracking
        this.updateServiceTracking(servicesWithSpecs);
        console.log(`✅ GraphQL Mesh updated with ${servicesWithSpecs.length} federated services`);
      }
      
      return success;
    } catch (error) {
      console.error('❌ Failed to update mesh configuration:', error.message);
      throw error;
    }
  }

  /**
   * Check if the discovered services have changed from current services
   * @param {Array} newServices - Newly discovered services
   * @returns {boolean} True if services have changed
   */
  hasServicesChanged(newServices) {
    if (newServices.length !== this.currentServices.size) {
      return true;
    }
    
    return newServices.some(service => {
      const currentService = this.currentServices.get(service.name);
      if (!currentService) return true;
      
      // Check if service URL or last updated changed
      return (
        currentService.url !== service.url ||
        currentService.lastUpdated !== service.lastUpdated ||
        JSON.stringify(currentService.openApiSpec) !== JSON.stringify(service.openApiSpec)
      );
    });
  }

  /**
   * Generate GraphQL Mesh configuration from services
   * @param {Array} services - Services with OpenAPI specifications
   * @returns {Object} Mesh configuration object
   */
  generateMeshConfig(services) {
    const sources = services.map(service => ({
      name: service.name,
      handler: {
        openapi: {
          source: service.openApiUrl || `${service.url}/openapi.json`,
          baseUrl: service.url,
          operationHeaders: this.buildOperationHeaders()
        }
      },
      transforms: [
        {
          prefix: {
            value: `${this.toPascalCase(service.name)}_`,
            includeRootOperations: true
          }
        },
        {
          namingConvention: {
            mode: 'bare',
            typeNames: 'pascalCase',
            fieldNames: 'camelCase'
          }
        }
      ]
    }));

    const config = {
      sources,
      serve: {
        port: 8080,
        hostname: '0.0.0.0',
        cors: {
          origin: '*',
          methods: ['GET', 'POST', 'OPTIONS'],
          allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
        },
        playground: true,
        introspection: true
      },
      logger: {
        level: 'info'
      },
      cache: {
        redis: false // Disable Redis for now - can be enabled later
      }
    };

    return config;
  }

  /**
   * Build operationHeaders for an openapi source.
   * GQL-1 (#155): when FORWARD_AUTH is enabled (default true) the gateway forwards
   * the incoming Authorization header (the caller's JWT, already validated by APIM)
   * to every upstream via the GraphQL Mesh `{context.headers.<name>}` interpolation,
   * so in-cluster services receive the original bearer token.
   * @returns {Object} operationHeaders map
   */
  buildOperationHeaders() {
    const headers = {
      'User-Agent': 'GraphQL-Mesh-Gateway/1.0',
      'Accept': 'application/json'
    };
    if (process.env.FORWARD_AUTH !== 'false') {
      headers['Authorization'] = '{context.headers.authorization}';
    }
    return headers;
  }

  /**
   * GQL-1 (#155): apply the authoritative explicit source list from the MESH_SOURCES
   * env var (JSON), bypassing kubectl service discovery entirely. Set by the
   * graphql-gateway CD when the OAM declares `sources:` (auto-filled by app.submit
   * from sibling webservices). Each entry: { name, source, headers? } where `source`
   * is a full OpenAPI spec URL (e.g. http://svc.ns.svc.cluster.local/openapi.json).
   * @returns {Promise<boolean>} True if the mesh was (re)built from explicit sources
   */
  async applyExplicitSources() {
    const raw = process.env.MESH_SOURCES;
    if (!raw) {
      console.log('⚠️  EXPLICIT_SOURCES set but MESH_SOURCES is empty; using fallback');
      return await this.createFallbackConfiguration();
    }

    let entries;
    try {
      entries = JSON.parse(raw);
    } catch (error) {
      console.error('❌ Failed to parse MESH_SOURCES JSON:', error.message);
      return await this.createFallbackConfiguration();
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      console.log('⚠️  MESH_SOURCES is empty/not a list; using fallback');
      return await this.createFallbackConfiguration();
    }

    console.log(`🔧 Building GraphQL Mesh from ${entries.length} explicit source(s) (MESH_SOURCES)`);

    const sources = entries.map(entry => {
      const specUrl = entry.source;
      // baseUrl = the spec URL minus its path component (host root), so Mesh
      // resolves operation paths against the service root, not the spec file.
      let baseUrl = specUrl;
      try {
        const u = new URL(specUrl);
        baseUrl = `${u.protocol}//${u.host}`;
      } catch (_) { /* leave baseUrl as specUrl if unparseable */ }

      const operationHeaders = Object.assign(this.buildOperationHeaders(), entry.headers || {});
      return {
        name: entry.name,
        handler: {
          openapi: {
            source: specUrl,
            baseUrl,
            operationHeaders
          }
        },
        transforms: [
          { prefix: { value: `${this.toPascalCase(entry.name)}_`, includeRootOperations: true } },
          { namingConvention: { mode: 'bare', typeNames: 'pascalCase', fieldNames: 'camelCase' } }
        ]
      };
    });

    const config = {
      sources,
      serve: {
        port: 8080,
        hostname: '0.0.0.0',
        cors: {
          origin: '*',
          methods: ['GET', 'POST', 'OPTIONS'],
          allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
        },
        playground: true,
        introspection: true
      },
      logger: { level: 'info' },
      cache: { redis: false }
    };

    this.writeMeshConfig(config);
    const success = await this.rebuildMesh(config);
    if (success) {
      // Track for /status + health without re-running discovery.
      this.currentServices.clear();
      entries.forEach(e => this.currentServices.set(e.name, {
        name: e.name, url: e.source, ready: true, hasOpenApi: true,
        lastUpdated: new Date().toISOString()
      }));
      console.log(`✅ GraphQL Mesh built from ${entries.length} explicit federated source(s)`);
    }
    return success;
  }

  /**
   * Create fallback configuration when no services are available
   * @returns {Promise<boolean>}
   */
  async createFallbackConfiguration() {
    console.log('🔧 Creating fallback GraphQL configuration');
    
    const fallbackConfig = {
      sources: [],
      serve: {
        port: 8080,
        hostname: '0.0.0.0',
        cors: {
          origin: '*',
          methods: ['GET', 'POST', 'OPTIONS'],
          allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
        },
        playground: true,
        introspection: true
      },
      logger: {
        level: 'info'
      }
    };

    this.writeMeshConfig(fallbackConfig);
    return await this.rebuildMesh(fallbackConfig);
  }

  /**
   * Write mesh configuration to file
   * @param {Object} config - Mesh configuration
   */
  writeMeshConfig(config) {
    const yaml = require('js-yaml');
    const configYaml = yaml.dump(config, { 
      indent: 2,
      lineWidth: 120,
      noRefs: true
    });
    
    writeFileSync(this.meshConfigPath, configYaml, 'utf8');
    console.log(`📄 Mesh configuration written to ${this.meshConfigPath}`);
  }

  /**
   * Rebuild GraphQL Mesh from an in-memory configuration object.
   *
   * GQL-FED-FIX (#159): the legacy `getMesh(processConfig(...))` flow replaces the
   * removed `findAndParseConfig` (deleted in @graphql-mesh/config 0.108.x). Callers
   * already hold the config OBJECT (applyExplicitSources / generateMeshConfig /
   * createFallbackConfiguration), so we process it directly instead of re-reading
   * `.meshrc.yml` from disk. The YAML file is still written by writeMeshConfig() for
   * debuggability, but is no longer a read dependency.
   *
   * The `logger` and `cache` keys are stripped before processConfig(): the legacy
   * processConfig() treats unknown top-level keys (logger:{level}, cache:{redis})
   * as package/module references and tries to `require()` them, which throws. They
   * are gateway-runtime concerns, not mesh-build concerns, so dropping them is safe.
   *
   * @param {Object} config - In-memory mesh configuration object (sources + serve + ...)
   * @returns {Promise<boolean>} True if successful
   */
  async rebuildMesh(config) {
    try {
      console.log('🔄 Rebuilding GraphQL Mesh...');

      // Dispose current mesh if exists
      if (this.mesh && typeof this.mesh.destroy === 'function') {
        await this.mesh.destroy();
      }

      if (!config || typeof config !== 'object') {
        throw new Error('rebuildMesh requires an in-memory config object');
      }

      // Strip gateway-runtime-only keys the legacy processConfig cannot resolve.
      const { logger, cache, ...meshBuildConfig } = config;

      // Process the in-memory config and build the federated mesh.
      const processed = await processConfig(meshBuildConfig, {
        dir: this.configPath,
        ignoreAdditionalResolvers: true
      });
      this.mesh = await getMesh(processed);

      console.log('✅ GraphQL Mesh rebuilt successfully');
      return true;
    } catch (error) {
      console.error('❌ Failed to rebuild mesh:', error.message);
      
      // Try to create a basic executable schema as fallback
      try {
        console.log('🔄 Creating fallback schema...');
        const fallbackSchema = this.createFallbackSchema();
        this.mesh = { schema: fallbackSchema };
        console.log('✅ Fallback schema created');
        return true;
      } catch (fallbackError) {
        console.error('❌ Failed to create fallback schema:', fallbackError.message);
        return false;
      }
    }
  }

  /**
   * Create a basic fallback schema when mesh fails
   * @returns {Object} GraphQL schema
   */
  createFallbackSchema() {
    const typeDefs = `
      type Query {
        status: String
        discoveredServices: [ServiceInfo]
      }
      
      type ServiceInfo {
        name: String!
        namespace: String!
        url: String
        ready: Boolean!
        hasOpenApi: Boolean!
      }
    `;

    const resolvers = {
      Query: {
        status: () => 'GraphQL Gateway is running with fallback schema',
        discoveredServices: () => Array.from(this.currentServices.values()).map(service => ({
          name: service.name,
          namespace: service.namespace,
          url: service.url,
          ready: service.ready,
          hasOpenApi: service.hasOpenApi
        }))
      }
    };

    return makeExecutableSchema({ typeDefs, resolvers });
  }

  /**
   * Update internal service tracking
   * @param {Array} services - Current services
   */
  updateServiceTracking(services) {
    this.currentServices.clear();
    services.forEach(service => {
      this.currentServices.set(service.name, {
        name: service.name,
        namespace: service.namespace,
        url: service.url,
        ready: service.ready,
        hasOpenApi: service.hasOpenApi,
        lastUpdated: service.lastUpdated,
        openApiSpec: service.openApiSpec
      });
    });
  }

  /**
   * Get current GraphQL schema
   * @returns {Object|null} Current GraphQL schema
   */
  getSchema() {
    if (!this.mesh) {
      return null;
    }
    
    return this.mesh.schema || this.mesh.getSchema?.();
  }

  /**
   * Get current mesh instance
   * @returns {Object|null} Current mesh instance
   */
  getMeshInstance() {
    return this.mesh;
  }

  /**
   * Get statistics about current configuration
   * @returns {Object} Configuration statistics
   */
  getStats() {
    return {
      servicesCount: this.currentServices.size,
      meshConfigured: !!this.mesh,
      configPath: this.meshConfigPath,
      services: Array.from(this.currentServices.keys())
    };
  }

  /**
   * Convert string to PascalCase
   * @param {string} str - Input string
   * @returns {string} PascalCase string
   */
  toPascalCase(str) {
    return str
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase())
      .replace(/\s/g, '');
  }

  /**
   * Health check for mesh manager
   * @returns {Object} Health status
   */
  getHealthStatus() {
    return {
      status: this.mesh ? 'healthy' : 'unhealthy',
      servicesCount: this.currentServices.size,
      meshConfigured: !!this.mesh,
      lastUpdate: new Date().toISOString(),
      configExists: existsSync(this.meshConfigPath)
    };
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    console.log('🧹 Cleaning up mesh manager resources...');
    
    if (this.mesh && typeof this.mesh.destroy === 'function') {
      await this.mesh.destroy();
    }
    
    this.mesh = null;
    this.currentServices.clear();
    this.currentSchemas.clear();
    
    console.log('✅ Mesh manager cleanup completed');
  }
}

module.exports = MeshManager;