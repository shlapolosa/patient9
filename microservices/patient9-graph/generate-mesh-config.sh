#!/bin/bash
set -e

echo "🔍 Starting GraphQL Mesh service discovery"

# Environment variables
SERVICE_SELECTOR="${SERVICE_SELECTOR:-{\"app.kubernetes.io/managed-by\":\"kubevela\"}}"
NAMESPACE="${NAMESPACE:-default}"
MESH_CONFIG_FILE="${MESH_CONFIG_FILE:-/app/.meshrc.yaml}"
GATEWAY_NAME="${GATEWAY_NAME:-api-gateway}"

# Function to check if a service has OpenAPI spec
check_openapi_endpoint() {
    local service_name=$1
    local namespace=$2
    local port=${3:-8080}
    
    echo "  📡 Checking OpenAPI endpoints for ${service_name}.${namespace}:${port}"
    
    # Try multiple common OpenAPI endpoints
    for endpoint in "/openapi.json" "/openapi" "/swagger.json" "/swagger" "/api/openapi.json" "/api/swagger.json" "/spec.json"; do
        response=$(curl -s -w "\n%{http_code}" --connect-timeout 5 --max-time 10 \
            "http://${service_name}.${namespace}.svc.cluster.local:${port}${endpoint}" 2>/dev/null || echo "000")
        http_code=$(echo "$response" | tail -n1)
        
        if [[ "$http_code" == "200" ]]; then
            echo "  ✅ Found OpenAPI spec at ${endpoint}"
            echo "http://${service_name}.${namespace}.svc.cluster.local:${port}${endpoint}"
            return 0
        fi
    done
    
    echo "  ⚠️  No OpenAPI spec found for ${service_name}"
    return 1
}

# Function to generate service name for GraphQL
generate_service_prefix() {
    local service_name=$1
    # Convert to PascalCase and add suffix
    echo "$service_name" | sed 's/-/_/g' | sed 's/\b\w/\U&/g'
}

# Main discovery process
echo "📊 Discovering Knative services"
echo "Selector: \"$SERVICE_SELECTOR\""
echo "Namespace: ${NAMESPACE}"

# Parse service selector JSON to kubectl label selector format
label_selector=$(echo "$SERVICE_SELECTOR" | jq -r 'to_entries | map("\(.key)=\(.value)") | join(",")')
echo "Label selector: ${label_selector}"

# Get all Knative services matching the selector
echo "🔍 Querying Kubernetes for services..."

if [[ -n "$label_selector" ]]; then
    services=$(kubectl get ksvc -A -l "$label_selector" -o json 2>/dev/null || echo '{"items":[]}')
else
    services=$(kubectl get ksvc -A -o json 2>/dev/null || echo '{"items":[]}')
fi

# Also check for services with GraphQL exposure annotation
echo "🔍 Checking for services with GraphQL annotations..."
graphql_services=$(kubectl get ksvc -A -l "graphql.oam.dev/exposed=true" -o json 2>/dev/null || echo '{"items":[]}')

# Combine and deduplicate services
echo "🔄 Combining and deduplicating services..."
all_services=$(echo "$services" "$graphql_services" | jq -s '.[0].items + .[1].items | unique_by(.metadata.name + .metadata.namespace)')

service_count=$(echo "$all_services" | jq length)
echo "📋 Found ${service_count} services to process"

# Initialize mesh configuration
echo "📝 Generating mesh configuration..."

# Start with template
cp /app/mesh-config-template.yaml /tmp/mesh-config.yaml

# Build sources array
sources_json="[]"

# Process each service
echo "$all_services" | jq -c '.[]' | while IFS= read -r service; do
    name=$(echo "$service" | jq -r '.metadata.name')
    namespace=$(echo "$service" | jq -r '.metadata.namespace')
    
    echo "🔍 Processing service: ${name} in namespace: ${namespace}"
    
    # Skip if it's our own gateway
    if [[ "$name" == *"hasura"* ]] || [[ "$name" == *"graphql-gateway"* ]] || [[ "$name" == "$GATEWAY_NAME" ]]; then
        echo "  ⏭️  Skipping gateway service: ${name}"
        continue
    fi
    
    # Check for OpenAPI endpoint
    if openapi_url=$(check_openapi_endpoint "$name" "$namespace"); then
        service_prefix=$(generate_service_prefix "$name")
        
        # Add to sources
        new_source=$(cat <<EOF
{
  "name": "${name}",
  "handler": {
    "openapi": {
      "source": "${openapi_url}",
      "operationHeaders": {
        "X-GraphQL-Gateway": "true",
        "X-Service-Name": "${name}"
      },
      "baseUrl": "http://${name}.${namespace}.svc.cluster.local:8080"
    }
  },
  "transforms": [
    {
      "prefix": {
        "value": "${service_prefix}_"
      }
    }
  ]
}
EOF
        )
        
        sources_json=$(echo "$sources_json" | jq ". + [$new_source]" --argjson new_source "$new_source")
        echo "  ✅ Added ${name} to mesh configuration"
    else
        echo "  ⚠️  Skipping ${name} - no OpenAPI spec found"
    fi
done

# Update the mesh configuration with discovered sources
echo "📄 Updating mesh configuration with discovered sources..."

# Read the final sources (since the while loop runs in a subshell, we need to handle this differently)
# Let's regenerate the sources by running the discovery again and capturing the output
final_sources="[]"

while IFS= read -r service; do
    name=$(echo "$service" | jq -r '.metadata.name')
    namespace=$(echo "$service" | jq -r '.metadata.namespace')
    
    # Skip gateway services
    if [[ "$name" == *"hasura"* ]] || [[ "$name" == *"graphql-gateway"* ]] || [[ "$name" == "$GATEWAY_NAME" ]]; then
        continue
    fi
    
    # Check for OpenAPI endpoint
    if openapi_url=$(check_openapi_endpoint "$name" "$namespace"); then
        service_prefix=$(generate_service_prefix "$name")
        
        new_source=$(cat <<EOF
{
  "name": "${name}",
  "handler": {
    "openapi": {
      "source": "${openapi_url}",
      "operationHeaders": {
        "X-GraphQL-Gateway": "true",
        "X-Service-Name": "${name}"
      },
      "baseUrl": "http://${name}.${namespace}.svc.cluster.local:8080"
    }
  },
  "transforms": [
    {
      "prefix": {
        "value": "${service_prefix}_"
      }
    }
  ]
}
EOF
        )
        
        final_sources=$(echo "$final_sources" | jq ". + [$new_source]" --argjson new_source "$new_source")
    fi
done < <(echo "$all_services" | jq -c '.[]')

# Generate the final mesh configuration
cat > "$MESH_CONFIG_FILE" << EOF
# GraphQL Mesh Configuration
# Generated at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Gateway: $GATEWAY_NAME
# Discovered services: $(echo "$final_sources" | jq length)

serve:
  port: 8080
  hostname: "0.0.0.0"
  cors:
    origin: "*"
    credentials: false
  playground: true
  endpoint: "/graphql"
  healthCheckEndpoint: "/healthz"

sources:
$(echo "$final_sources" | yq eval '.' -)

transforms:
  # Global transforms to namespace each service
  - rename:
      mode: wrap
      renames:
        - from:
            type: "Query"
            field: "*"
          to:
            type: "Query"
            field: "{field.name}"

additionalTypeDefs: |
  type Query {
    _gateway: String!
    _health: String!
    _services: [String!]!
  }
  
  extend type Query {
    _gatewayInfo: GatewayInfo!
  }
  
  type GatewayInfo {
    name: String!
    version: String!
    servicesCount: Int!
    lastUpdated: String!
  }

cache:
  inmemory: {}

logger:
  level: info
  format: json
EOF

# Validate the generated configuration
echo "✅ Generated mesh configuration with $(echo "$final_sources" | jq length) services"

# Output summary
echo "📊 Discovery Summary:"
echo "  - Services discovered: $(echo "$final_sources" | jq length)"
echo "  - Configuration file: $MESH_CONFIG_FILE"
echo "  - Gateway: $GATEWAY_NAME"

# Show discovered services
if [[ $(echo "$final_sources" | jq length) -gt 0 ]]; then
    echo "  - Discovered services:"
    echo "$final_sources" | jq -r '.[] | "    • " + .name + " (" + .handler.openapi.source + ")"'
fi

echo "✨ Mesh configuration generation completed!"