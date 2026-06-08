/**
 * OpenAPI to GraphQL Schema Generator
 * Converts OpenAPI specifications to GraphQL schemas and resolvers
 */

const { makeExecutableSchema } = require('@graphql-tools/schema');
const fetch = require('node-fetch');

class SchemaGenerator {
  constructor() {
    this.typeMap = new Map();
    this.fieldMap = new Map();
  }

  /**
   * Generate GraphQL schema from OpenAPI specification
   * @param {Object} openApiSpec - OpenAPI specification
   * @param {Object} service - Service metadata
   * @returns {Object} GraphQL schema with typeDefs and resolvers
   */
  async generateFromOpenAPI(openApiSpec, service) {
    try {
      console.log(`🔧 Generating GraphQL schema for service: ${service.name}`);
      
      const typeDefs = this.openApiToGraphQLTypeDefs(openApiSpec, service);
      const resolvers = this.createResolvers(openApiSpec, service);
      
      return {
        typeDefs,
        resolvers,
        serviceName: service.name,
        namespace: service.namespace
      };
    } catch (error) {
      console.error(`❌ Schema generation failed for ${service.name}:`, error.message);
      throw error;
    }
  }

  /**
   * Convert OpenAPI specification to GraphQL type definitions
   * @param {Object} spec - OpenAPI specification
   * @param {Object} service - Service metadata
   * @returns {string} GraphQL type definitions
   */
  openApiToGraphQLTypeDefs(spec, service) {
    const serviceName = this.toPascalCase(service.name);
    let typeDefs = '';
    
    // Generate types from OpenAPI components/definitions
    if (spec.components?.schemas) {
      typeDefs += this.generateTypesFromSchemas(spec.components.schemas);
    } else if (spec.definitions) {
      // Swagger 2.0 format
      typeDefs += this.generateTypesFromSchemas(spec.definitions);
    }
    
    // Generate Query type from GET endpoints
    const queryFields = this.generateQueryFields(spec, service);
    if (queryFields.length > 0) {
      typeDefs += `\nextend type Query {\n${queryFields.join('\n')}\n}\n`;
    }
    
    // Generate Mutation type from POST/PUT/DELETE endpoints
    const mutationFields = this.generateMutationFields(spec, service);
    if (mutationFields.length > 0) {
      typeDefs += `\nextend type Mutation {\n${mutationFields.join('\n')}\n}\n`;
    }
    
    console.log(`  📋 Generated ${queryFields.length} queries, ${mutationFields.length} mutations for ${service.name}`);
    
    return typeDefs;
  }

  /**
   * Generate GraphQL types from OpenAPI schemas
   * @param {Object} schemas - OpenAPI schemas
   * @returns {string} GraphQL type definitions
   */
  generateTypesFromSchemas(schemas) {
    let typeDefs = '';
    
    Object.entries(schemas).forEach(([name, schema]) => {
      const typeName = this.toPascalCase(name);
      
      if (schema.type === 'object' && schema.properties) {
        typeDefs += `\ntype ${typeName} {\n`;
        
        Object.entries(schema.properties).forEach(([propName, propSchema]) => {
          const fieldName = this.toCamelCase(propName);
          const fieldType = this.openApiTypeToGraphQLType(propSchema);
          const required = schema.required?.includes(propName) ? '!' : '';
          
          typeDefs += `  ${fieldName}: ${fieldType}${required}\n`;
        });
        
        typeDefs += '}\n';
      } else if (schema.enum) {
        // Generate enum type
        typeDefs += `\nenum ${typeName} {\n`;
        schema.enum.forEach(value => {
          typeDefs += `  ${String(value).toUpperCase().replace(/[^A-Z0-9_]/g, '_')}\n`;
        });
        typeDefs += '}\n';
      }
    });
    
    return typeDefs;
  }

  /**
   * Generate Query fields from GET endpoints
   * @param {Object} spec - OpenAPI specification
   * @param {Object} service - Service metadata
   * @returns {Array<string>} Array of GraphQL query field definitions
   */
  generateQueryFields(spec, service) {
    const queryFields = [];
    const servicePrefix = this.toCamelCase(service.name);
    
    Object.entries(spec.paths || {}).forEach(([path, methods]) => {
      if (methods.get) {
        const operation = methods.get;
        const fieldName = this.generateFieldName(servicePrefix, path, 'get');
        const returnType = this.getReturnType(operation);
        const args = this.generateFieldArguments(operation.parameters || []);
        
        queryFields.push(`  ${fieldName}${args}: ${returnType}`);
        
        // Store field mapping for resolver
        this.fieldMap.set(fieldName, {
          method: 'GET',
          path,
          service,
          operation
        });
      }
    });
    
    return queryFields;
  }

  /**
   * Generate Mutation fields from POST/PUT/DELETE endpoints
   * @param {Object} spec - OpenAPI specification
   * @param {Object} service - Service metadata
   * @returns {Array<string>} Array of GraphQL mutation field definitions
   */
  generateMutationFields(spec, service) {
    const mutationFields = [];
    const servicePrefix = this.toCamelCase(service.name);
    
    Object.entries(spec.paths || {}).forEach(([path, methods]) => {
      ['post', 'put', 'patch', 'delete'].forEach(method => {
        if (methods[method]) {
          const operation = methods[method];
          const fieldName = this.generateFieldName(servicePrefix, path, method);
          const returnType = this.getReturnType(operation);
          const args = this.generateMutationArguments(operation);
          
          mutationFields.push(`  ${fieldName}${args}: ${returnType}`);
          
          // Store field mapping for resolver
          this.fieldMap.set(fieldName, {
            method: method.toUpperCase(),
            path,
            service,
            operation
          });
        }
      });
    });
    
    return mutationFields;
  }

  /**
   * Generate field name from service, path, and method
   * @param {string} servicePrefix - Service name prefix
   * @param {string} path - API path
   * @param {string} method - HTTP method
   * @returns {string} GraphQL field name
   */
  generateFieldName(servicePrefix, path, method) {
    // Convert path to camelCase and remove parameters
    const pathParts = path
      .split('/')
      .filter(part => part && !part.startsWith('{'))
      .map(part => this.toPascalCase(part));
    
    const actionMap = {
      'get': 'get',
      'post': 'create',
      'put': 'update',
      'patch': 'update',
      'delete': 'delete'
    };
    
    const action = actionMap[method] || method;
    
    if (pathParts.length === 0) {
      return `${servicePrefix}${this.toPascalCase(action)}`;
    }
    
    return `${servicePrefix}${this.toPascalCase(action)}${pathParts.join('')}`;
  }

  /**
   * Generate field arguments from OpenAPI parameters
   * @param {Array} parameters - OpenAPI parameters
   * @returns {string} GraphQL field arguments
   */
  generateFieldArguments(parameters) {
    if (!parameters || parameters.length === 0) {
      return '';
    }
    
    const args = parameters.map(param => {
      const argName = this.toCamelCase(param.name);
      const argType = this.openApiTypeToGraphQLType(param.schema || param);
      const required = param.required ? '!' : '';
      
      return `${argName}: ${argType}${required}`;
    });
    
    return `(${args.join(', ')})`;
  }

  /**
   * Generate mutation arguments including request body
   * @param {Object} operation - OpenAPI operation
   * @returns {string} GraphQL field arguments
   */
  generateMutationArguments(operation) {
    const args = [];
    
    // Add path and query parameters
    if (operation.parameters) {
      operation.parameters.forEach(param => {
        const argName = this.toCamelCase(param.name);
        const argType = this.openApiTypeToGraphQLType(param.schema || param);
        const required = param.required ? '!' : '';
        args.push(`${argName}: ${argType}${required}`);
      });
    }
    
    // Add request body as input
    if (operation.requestBody) {
      const content = operation.requestBody.content;
      if (content['application/json']) {
        const schema = content['application/json'].schema;
        const inputType = this.openApiTypeToGraphQLType(schema);
        const required = operation.requestBody.required ? '!' : '';
        args.push(`input: ${inputType}${required}`);
      }
    }
    
    return args.length > 0 ? `(${args.join(', ')})` : '';
  }

  /**
   * Get return type from OpenAPI operation
   * @param {Object} operation - OpenAPI operation
   * @returns {string} GraphQL return type
   */
  getReturnType(operation) {
    const responses = operation.responses || {};
    
    // Look for success response (200, 201, etc.)
    const successResponse = responses['200'] || responses['201'] || responses['204'];
    
    if (!successResponse) {
      return 'String'; // Fallback
    }
    
    const content = successResponse.content;
    if (content && content['application/json']) {
      const schema = content['application/json'].schema;
      return this.openApiTypeToGraphQLType(schema);
    }
    
    return 'String';
  }

  /**
   * Convert OpenAPI type to GraphQL type
   * @param {Object} schema - OpenAPI schema
   * @returns {string} GraphQL type
   */
  openApiTypeToGraphQLType(schema) {
    if (!schema) return 'String';
    
    if (schema.$ref) {
      // Extract type name from reference
      const typeName = schema.$ref.split('/').pop();
      return this.toPascalCase(typeName);
    }
    
    switch (schema.type) {
      case 'string':
        if (schema.format === 'date-time' || schema.format === 'date') {
          return 'String'; // Could be DateTime scalar
        }
        return 'String';
      case 'integer':
      case 'number':
        return schema.format === 'float' ? 'Float' : 'Int';
      case 'boolean':
        return 'Boolean';
      case 'array':
        const itemType = this.openApiTypeToGraphQLType(schema.items);
        return `[${itemType}]`;
      case 'object':
        if (schema.properties) {
          // Generate inline type or reference existing one
          return 'JSON'; // Generic JSON scalar for complex objects
        }
        return 'JSON';
      default:
        return 'String';
    }
  }

  /**
   * Create resolvers for the generated schema
   * @param {Object} spec - OpenAPI specification
   * @param {Object} service - Service metadata
   * @returns {Object} GraphQL resolvers
   */
  createResolvers(spec, service) {
    const resolvers = {
      Query: {},
      Mutation: {}
    };
    
    // Create resolvers for each mapped field
    this.fieldMap.forEach((mapping, fieldName) => {
      if (mapping.service.name === service.name) {
        const resolver = this.createFieldResolver(mapping);
        
        if (mapping.method === 'GET') {
          resolvers.Query[fieldName] = resolver;
        } else {
          resolvers.Mutation[fieldName] = resolver;
        }
      }
    });
    
    return resolvers;
  }

  /**
   * Create a resolver function for a specific field
   * @param {Object} mapping - Field mapping configuration
   * @returns {Function} GraphQL resolver function
   */
  createFieldResolver(mapping) {
    return async (parent, args, context, info) => {
      try {
        const { method, path, service, operation } = mapping;
        
        // Build the URL
        let url = `${service.url}${this.interpolatePath(path, args)}`;
        
        // Add query parameters for GET requests
        if (method === 'GET' && Object.keys(args).length > 0) {
          const queryParams = new URLSearchParams();
          Object.entries(args).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
              queryParams.append(key, String(value));
            }
          });
          
          if (queryParams.toString()) {
            url += `?${queryParams.toString()}`;
          }
        }
        
        // Prepare request options
        const requestOptions = {
          method,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'GraphQL-Gateway/1.0',
            ...this.forwardHeaders(context)
          },
          timeout: 30000 // 30 second timeout
        };
        
        // Add request body for mutations
        if (method !== 'GET' && args.input) {
          requestOptions.body = JSON.stringify(args.input);
        }
        
        console.log(`🔍 ${method} ${url}`);
        
        const response = await fetch(url, requestOptions);
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          return await response.json();
        } else {
          return await response.text();
        }
        
      } catch (error) {
        console.error(`❌ Resolver error for ${mapping.service.name}.${info.fieldName}:`, error.message);
        throw error;
      }
    };
  }

  /**
   * Interpolate path parameters in URL path
   * @param {string} path - URL path with parameters like /users/{id}
   * @param {Object} args - GraphQL field arguments
   * @returns {string} Interpolated path
   */
  interpolatePath(path, args) {
    return path.replace(/{([^}]+)}/g, (match, paramName) => {
      const value = args[this.toCamelCase(paramName)];
      if (value === undefined) {
        throw new Error(`Missing path parameter: ${paramName}`);
      }
      return encodeURIComponent(value);
    });
  }

  /**
   * Forward relevant headers from GraphQL context to service requests
   * @param {Object} context - GraphQL context
   * @returns {Object} Headers to forward
   */
  forwardHeaders(context) {
    const headersToForward = [
      'authorization',
      'x-api-key',
      'x-user-id',
      'x-tenant-id'
    ];
    
    const headers = {};
    const requestHeaders = context.request?.headers || context.headers || {};
    
    headersToForward.forEach(header => {
      const value = requestHeaders[header] || requestHeaders[header.toLowerCase()];
      if (value) {
        headers[header] = value;
      }
    });
    
    return headers;
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
   * Convert string to camelCase
   * @param {string} str - Input string
   * @returns {string} camelCase string
   */
  toCamelCase(str) {
    const pascal = this.toPascalCase(str);
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
  }
}

module.exports = SchemaGenerator;