/**
 * Service Discovery Engine
 * Discovers Knative services and extracts OpenAPI specifications
 */

const { spawn } = require('child_process');
const util = require('util');
const fetch = require('node-fetch');

class ServiceDiscovery {
  constructor(namespace = 'default') {
    this.namespace = namespace;
    this.execAsync = util.promisify(spawn);
    // Federation annotation that services must have to be included
    this.FEDERATION_ANNOTATION = 'graphql.federation/enabled';
  }

  /**
   * Discover Knative services using kubectl with label selector
   * @param {string} labelSelector - Kubernetes label selector (e.g., "app=value,tier=frontend")
   * @returns {Promise<Array>} Array of discovered services
   */
  async discoverKnativeServices(labelSelector = '') {
    try {
      console.log(`🔍 Discovering Knative services with selector: ${labelSelector}`);
      
      // Build kubectl command
      let command = ['get', 'ksvc', '-o', 'json'];
      
      // Add namespace parameter
      if (this.namespace !== 'all') {
        command.push('-n', this.namespace);
      } else {
        command.push('--all-namespaces');
      }
      
      // Add label selector if provided
      if (labelSelector && labelSelector.trim()) {
        command.push('-l', labelSelector.trim());
      }
      
      const result = await this.executeKubectl(command);
      const services = JSON.parse(result.stdout);
      
      console.log(`📊 Found ${services.items.length} Knative services`);
      
      // Filter services that are explicitly marked for federation
      const federationServices = services.items.filter(service => {
        const annotations = service.metadata.annotations || {};
        const isFederationEnabled = annotations[this.FEDERATION_ANNOTATION] === 'true';
        
        if (!isFederationEnabled) {
          console.log(`  ⏭️  Skipping ${service.metadata.name} - not marked for GraphQL federation`);
        }
        
        return isFederationEnabled;
      });
      
      console.log(`🎯 ${federationServices.length} services marked for GraphQL federation`);
      
      return this.extractServiceEndpoints(federationServices);
    } catch (error) {
      console.error('❌ Service discovery failed:', error.message);
      throw error;
    }
  }

  /**
   * Execute kubectl command with proper error handling
   * @param {Array} args - kubectl command arguments
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async executeKubectl(args) {
    return new Promise((resolve, reject) => {
      const kubectl = spawn('kubectl', args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      kubectl.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      kubectl.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      kubectl.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr, code });
        } else {
          reject(new Error(`kubectl failed with code ${code}: ${stderr}`));
        }
      });

      kubectl.on('error', (error) => {
        reject(new Error(`Failed to execute kubectl: ${error.message}`));
      });
    });
  }

  /**
   * Extract service endpoints and metadata from Knative services
   * @param {Array} services - Array of Knative service objects
   * @returns {Array} Array of service endpoint objects
   */
  extractServiceEndpoints(services) {
    return services.map(service => {
      const name = service.metadata.name;
      const namespace = service.metadata.namespace;
      const labels = service.metadata.labels || {};
      const annotations = service.metadata.annotations || {};
      
      // Extract URL from status
      const url = service.status?.url;
      const ready = service.status?.conditions?.some(
        condition => condition.type === 'Ready' && condition.status === 'True'
      ) || false;

      // Look for OpenAPI annotations
      const openApiPath = annotations['openapi.path'] || null;
      const apiVersion = annotations['api.version'] || 'v1';
      
      const serviceInfo = {
        name,
        namespace,
        url,
        ready,
        labels,
        annotations,
        apiVersion,
        openApiPath,
        // Internal service URL for cluster communication
        internalUrl: `http://${name}.${namespace}.svc.cluster.local`,
        // Last update timestamp
        lastUpdated: service.metadata.resourceVersion
      };

      console.log(`  📋 Service: ${name}.${namespace} - Ready: ${ready} - URL: ${url}`);
      
      return serviceInfo;
    }).filter(service => service.url); // Only return services with URLs
  }

  /**
   * Probe services for OpenAPI specifications
   * @param {Array} services - Array of service objects
   * @returns {Promise<Array>} Array of services with OpenAPI specs
   */
  async probeOpenApiEndpoints(services) {
    console.log(`🔍 Probing ${services.length} services for OpenAPI specifications...`);
    
    const servicesWithSpecs = [];
    
    for (const service of services) {
      try {
        const spec = await this.findOpenApiSpec(service);
        if (spec) {
          servicesWithSpecs.push({
            ...service,
            openApiSpec: spec.spec,
            openApiUrl: spec.url,
            hasOpenApi: true
          });
          console.log(`  ✅ ${service.name}: Found OpenAPI spec at ${spec.url}`);
        } else {
          console.log(`  ⚠️  ${service.name}: No OpenAPI spec found`);
          // Still include the service but mark as no OpenAPI
          servicesWithSpecs.push({
            ...service,
            hasOpenApi: false,
            openApiSpec: null,
            openApiUrl: null
          });
        }
      } catch (error) {
        console.error(`  ❌ ${service.name}: Error probing OpenAPI - ${error.message}`);
        // Include service but mark as error
        servicesWithSpecs.push({
          ...service,
          hasOpenApi: false,
          openApiSpec: null,
          openApiUrl: null,
          error: error.message
        });
      }
    }
    
    const specCount = servicesWithSpecs.filter(s => s.hasOpenApi).length;
    console.log(`📊 Found OpenAPI specs in ${specCount}/${services.length} services`);
    
    return servicesWithSpecs;
  }

  /**
   * Find OpenAPI specification for a service
   * @param {Object} service - Service object
   * @returns {Promise<{spec: Object, url: string}|null>}
   */
  async findOpenApiSpec(service) {
    // List of common OpenAPI endpoint paths
    const commonPaths = [
      '/openapi.json',
      '/openapi',
      '/swagger.json',
      '/swagger',
      '/api/openapi.json',
      '/api/swagger.json',
      '/api/v1/openapi.json',
      '/v1/openapi.json',
      '/docs/openapi.json',
      '/.well-known/openapi.json',
      '/spec.json',
      '/api-docs'
    ];

    // If service has a custom OpenAPI path annotation, try that first
    if (service.openApiPath) {
      commonPaths.unshift(service.openApiPath);
    }

    // Try each endpoint path using internal cluster URL for probing
    for (const path of commonPaths) {
      try {
        const url = `${service.internalUrl}${path}`;
        console.log(`    🔍 Trying: ${url}`);
        
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'GraphQL-Gateway-Discovery/1.0'
          },
          timeout: 10000 // 10 second timeout
        });

        if (response.ok) {
          const contentType = response.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            const spec = await response.json();
            
            // Validate that it's actually an OpenAPI spec
            if (this.isValidOpenApiSpec(spec)) {
              return { spec, url };
            } else {
              console.log(`    ⚠️  Invalid OpenAPI spec at ${url}`);
            }
          }
        }
      } catch (error) {
        // Continue to next path - expected for most endpoints
        continue;
      }
    }

    return null;
  }

  /**
   * Validate if the response is a valid OpenAPI specification
   * @param {Object} spec - Potential OpenAPI specification
   * @returns {boolean}
   */
  isValidOpenApiSpec(spec) {
    // Check for OpenAPI 3.x
    if (spec.openapi && spec.openapi.startsWith('3.')) {
      return !!(spec.info && spec.paths);
    }
    
    // Check for Swagger 2.0
    if (spec.swagger && spec.swagger === '2.0') {
      return !!(spec.info && spec.paths);
    }
    
    return false;
  }

  /**
   * Get all regular Kubernetes services (non-Knative) for fallback discovery
   * @param {string} labelSelector - Label selector
   * @returns {Promise<Array>}
   */
  async discoverRegularServices(labelSelector = '') {
    try {
      console.log(`🔍 Discovering regular K8s services with selector: ${labelSelector}`);
      
      let command = ['get', 'svc', '-o', 'json'];
      
      if (this.namespace !== 'all') {
        command.push('-n', this.namespace);
      } else {
        command.push('--all-namespaces');
      }
      
      if (labelSelector && labelSelector.trim()) {
        command.push('-l', labelSelector.trim());
      }
      
      const result = await this.executeKubectl(command);
      const services = JSON.parse(result.stdout);
      
      return services.items.map(service => {
        const name = service.metadata.name;
        const namespace = service.metadata.namespace;
        const ports = service.spec.ports || [];
        
        // Find HTTP port
        const httpPort = ports.find(p => 
          p.name === 'http' || 
          p.name === 'http-web' || 
          p.port === 80 || 
          p.port === 8080
        ) || ports[0];
        
        if (!httpPort) return null;
        
        return {
          name,
          namespace,
          url: `http://${name}.${namespace}.svc.cluster.local:${httpPort.port}`,
          internalUrl: `http://${name}.${namespace}.svc.cluster.local:${httpPort.port}`,
          ready: true,
          labels: service.metadata.labels || {},
          annotations: service.metadata.annotations || {},
          type: 'kubernetes-service',
          port: httpPort.port
        };
      }).filter(Boolean);
    } catch (error) {
      console.error('❌ Regular service discovery failed:', error.message);
      return [];
    }
  }

  /**
   * Discover all services (Knative + regular K8s services)
   * @param {string} labelSelector - Label selector
   * @returns {Promise<Array>}
   */
  async discoverAllServices(labelSelector = '') {
    try {
      // Discover both types in parallel
      const [knativeServices, regularServices] = await Promise.all([
        this.discoverKnativeServices(labelSelector).catch(() => []),
        this.discoverRegularServices(labelSelector).catch(() => [])
      ]);
      
      const allServices = [...knativeServices, ...regularServices];
      console.log(`📊 Total discovered: ${allServices.length} services (${knativeServices.length} Knative, ${regularServices.length} regular)`);
      
      return allServices;
    } catch (error) {
      console.error('❌ Service discovery failed:', error.message);
      return [];
    }
  }
}

module.exports = ServiceDiscovery;