#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: ./scripts/deploy.sh <name>"
  echo "Example: ./scripts/deploy.sh deniz"
  exit 1
fi

NAME="$1"
VAR_FILE="environments/${NAME}.tfvars"

if [ ! -f "$VAR_FILE" ]; then
  echo "Error: $VAR_FILE not found"
  echo "Copy environments/template.tfvars to $VAR_FILE and fill in values"
  exit 1
fi

cd "$(dirname "$0")/../terraform"

terraform init
terraform workspace select "$NAME" 2>/dev/null || terraform workspace new "$NAME"
terraform apply -var-file="../terraform.tfvars" -var-file="../${VAR_FILE}"
