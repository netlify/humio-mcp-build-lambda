# humio-mcp Lambda Layer Build

Builds the humio-mcp Lambda layer artifact for use with the AWS DevOps Agent.

## Overview

This repository contains the build configuration for the humio-mcp Lambda layer. On each commit to `main`, GitHub Actions:

1. Compiles the TypeScript handler
2. Clones humio-mcp from GitHub
3. Packages everything as a Lambda layer ZIP
4. Publishes to GitHub releases

The artifact is then downloaded by the Terraform module in `terraform-devops-agent`.

## Files

- **handler.ts** - Lambda handler that proxies HTTP requests to humio-mcp subprocess
- **build_layer.sh** - Build script that compiles handler and packages layer
- **package.json** - Node.js dependencies for the handler
- **tsconfig.json** - TypeScript configuration

## Build Process

GitHub Actions automatically builds on:
- Pushes to `main` that modify handler.ts, build_layer.sh, package.json, or tsconfig.json
- Manual workflow dispatch

### Outputs

- `humio_mcp_layer.zip` - Lambda layer artifact
- Released to GitHub releases with:
  - Commit-specific tag: `<commit-sha>`
  - Persistent `latest` tag pointing to most recent build

## Usage

The artifact is downloaded automatically by the Terraform module. Specify the download URL:

```hcl
module "humio_mcp_lambda" {
  source = "..."
  
  layer_artifact_url = "https://github.com/netlify/humio-mcp-build-lambda/releases/download/latest/humio_mcp_layer.zip"
}
```

## Building Locally

To build the layer locally:

```bash
bash build_layer.sh
ls -lh .terraform/humio_mcp_layer.zip
```

Requirements:
- Node.js 20+
- npm
- git

## Related

- **Source**: [terraform-devops-agent](https://github.com/netlify/terraform-devops-agent)
- **Module**: `_infra/terraform/modules/humio-mcp-lambda`