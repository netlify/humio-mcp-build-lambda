#!/bin/bash
# Build script for humio-mcp Lambda layer and handler

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="${SCRIPT_DIR}/.terraform"
BUILD_DIR="${TF_DIR}/layer_build"
LAYER_ZIP="${TF_DIR}/humio_mcp_layer.zip"
HANDLER_OUTPUT="${SCRIPT_DIR}/handler.js"

echo "Building humio-mcp Lambda deployment..."

# Ensure .terraform directory exists
mkdir -p "$TF_DIR"

# Clean up previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Compile TypeScript handler to JavaScript
echo "Compiling TypeScript handler..."
if ! npx tsc --version > /dev/null 2>&1; then
    echo "Installing TypeScript and type definitions..."
    npm install --save-dev typescript @types/node @types/aws-lambda
fi
cd "${SCRIPT_DIR}"
npx tsc || {
    echo "Error: TypeScript compilation failed"
    exit 1
}
cd - > /dev/null

# Copy compiled handler to module root for packaging
if [ -f "$BUILD_DIR/handler.js" ]; then
    cp "$BUILD_DIR/handler.js" "$HANDLER_OUTPUT"
    echo "Handler compiled: $HANDLER_OUTPUT"
else
    echo "Error: handler.js not found in build output"
    exit 1
fi

# Build humio-mcp dependencies
echo "Building humio-mcp dependencies..."
HUMIO_MCP_SOURCE="${BUILD_DIR}/humio-mcp-src"
HUMIO_MCP_REPO="https://github.com/islam3zzat/humio-mcp.git"
HUMIO_MCP_REF="main"

# Clone humio-mcp from GitHub
if [ ! -d "$HUMIO_MCP_SOURCE" ]; then
    echo "Cloning humio-mcp from $HUMIO_MCP_REPO (ref: $HUMIO_MCP_REF)..."
    git clone --depth 1 --branch "$HUMIO_MCP_REF" "$HUMIO_MCP_REPO" "$HUMIO_MCP_SOURCE" || {
        echo "Error: Failed to clone humio-mcp from GitHub"
        exit 1
    }
fi

cd "$HUMIO_MCP_SOURCE"

echo "Installing humio-mcp dependencies..."
npm install || {
    echo "Error: Failed to install dependencies"
    exit 1
}

echo "Building humio-mcp..."
npm run build || {
    echo "Error: Failed to build humio-mcp"
    exit 1
}

# Copy node_modules and dist to layer build directory
echo "Packaging layer dependencies..."
mkdir -p "$BUILD_DIR/node_modules"
cp -r "$HUMIO_MCP_SOURCE/node_modules" "$BUILD_DIR/" || {
    echo "Error: Failed to copy node_modules"
    exit 1
}

mkdir -p "$BUILD_DIR/dist"
cp -r "$HUMIO_MCP_SOURCE/dist" "$BUILD_DIR/" || {
    echo "Error: Failed to copy dist"
    exit 1
}

# Create layer ZIP
echo "Creating Lambda layer ZIP..."
cd "$BUILD_DIR"
if [ -f "$LAYER_ZIP" ]; then
    rm "$LAYER_ZIP"
fi

zip -r -q "$LAYER_ZIP" node_modules dist || {
    echo "Error: Failed to create ZIP"
    exit 1
}

# Verify ZIP was created
if [ ! -f "$LAYER_ZIP" ]; then
    echo "Error: Layer ZIP was not created at $LAYER_ZIP"
    exit 1
fi

LAYER_SIZE=$(du -h "$LAYER_ZIP" | cut -f1)
echo "✓ Layer built successfully: $LAYER_ZIP"
echo "✓ Layer size: $LAYER_SIZE"

# Warn if layer is too large
LAYER_SIZE_MB=$(du -m "$LAYER_ZIP" | cut -f1)
if [ "$LAYER_SIZE_MB" -gt 250 ]; then
    echo "Warning: Layer exceeds 250MB. Lambda layers have a 250MB uncompressed limit."
    echo "Current size: ${LAYER_SIZE_MB}MB"
    exit 1
fi

echo "✓ Build complete"