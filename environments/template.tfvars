# Per-instance configuration
# Copy this file: cp environments/template.tfvars environments/<name>.tfvars
# Fill in values, then deploy: ./scripts/deploy.sh <name>

instance_name = ""

# API keys — leave blank if not using that provider
anthropic_api_key  = ""
openai_api_key     = ""
gemini_api_key     = ""
openrouter_api_key = ""
xai_api_key        = ""

# Unique auth token for this instance's gateway
# Generate with: openssl rand -hex 32
gateway_token = ""
