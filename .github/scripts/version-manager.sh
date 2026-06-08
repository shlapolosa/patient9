#!/bin/bash
set -e

# Semantic Versioning Manager for GitOps
# Generates semantic versions with commit SHA for container tagging

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Default values
MAJOR_VERSION=1
MINOR_VERSION=1
BASE_VERSION_FILE="$PROJECT_ROOT/.version"

# Read base version from file if it exists
if [ -f "$BASE_VERSION_FILE" ]; then
    BASE_VERSION=$(cat "$BASE_VERSION_FILE")
    MAJOR_VERSION=$(echo "$BASE_VERSION" | cut -d. -f1)
    MINOR_VERSION=$(echo "$BASE_VERSION" | cut -d. -f2)
fi

# Function to get commit count for patch version
get_patch_version() {
    git rev-list --count HEAD 2>/dev/null || echo "0"
}

# Function to get short commit SHA
get_commit_sha() {
    git rev-parse --short=7 HEAD 2>/dev/null || echo "unknown"
}

# Function to get branch name (sanitized for container tags)
get_branch_name() {
    local branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
    # Sanitize branch name for container registry
    echo "$branch" | sed 's/[^a-zA-Z0-9._-]/-/g' | tr '[:upper:]' '[:lower:]'
}

# Function to check if this is a release branch
is_release_branch() {
    local branch=$(get_branch_name)
    [[ "$branch" == "main" || "$branch" == "master" || "$branch" =~ ^release/.* ]]
}

# Function to generate semantic version
generate_semantic_version() {
    local service_name="$1"
    local commit_sha=$(get_commit_sha)
    
    # Use major.minor.sha format for Docker compatibility
    local semver="$MAJOR_VERSION.$MINOR_VERSION.$commit_sha"
    
    echo "$semver"
}

# Function to generate container tags
generate_container_tags() {
    local service_name="$1"
    local registry="${2:-docker.io/socrates12345}"
    local commit_sha=$(get_commit_sha)
    local branch=$(get_branch_name)
    local semver=$(generate_semantic_version "$service_name")
    
    # Base image name
    local image_base="$registry/$service_name"
    
    # Generate multiple tags
    local tags=()
    
    # 1. Full semantic version tag
    tags+=("$image_base:$semver")
    
    # 2. Short SHA tag
    tags+=("$image_base:$commit_sha")
    
    # 3. Branch-specific tag
    tags+=("$image_base:$branch-$commit_sha")
    
    # 4. Latest tag for main/master branch
    if is_release_branch; then
        tags+=("$image_base:latest")
        tags+=("$image_base:$MAJOR_VERSION")
        tags+=("$image_base:$MAJOR_VERSION.$MINOR_VERSION")
    fi
    
    # 5. Development tag for feature branches
    if [[ "$branch" == "develop" ]]; then
        tags+=("$image_base:develop")
    fi
    
    # Return as comma-separated string
    IFS=','
    echo "${tags[*]}"
}

# Main function
main() {
    local command="$1"
    local service_name="$2"
    local registry="${3:-docker.io/socrates12345}"
    
    case "$command" in
        "version")
            generate_semantic_version "$service_name"
            ;;
        "tags")
            generate_container_tags "$service_name" "$registry"
            ;;
        "help"|*)
            cat << HELP_EOF
Usage: $0 <command> [service_name] [registry]

Commands:
  version <service>           Generate semantic version
  tags <service> [registry]   Generate container tags
  help                        Show this help

Examples:
  $0 version accommodation-service
  $0 tags accommodation-service
HELP_EOF
            ;;
    esac
}

# Run main function with all arguments
main "$@"
