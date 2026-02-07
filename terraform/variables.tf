# Shared infrastructure secrets (terraform.tfvars)
variable "hetzner_api_key" {
  type      = string
  sensitive = true
}

variable "ssh_public_key" {
  type = string
}

variable "tailscale_authkey" {
  type      = string
  sensitive = true
}

# Per-instance config (environments/<name>.tfvars)
variable "instance_name" {
  type = string
}

variable "anthropic_api_key" {
  type      = string
  sensitive = true
  default   = ""
}

variable "openai_api_key" {
  type      = string
  sensitive = true
  default   = ""
}

variable "gemini_api_key" {
  type      = string
  sensitive = true
  default   = ""
}

variable "openrouter_api_key" {
  type      = string
  sensitive = true
  default   = ""
}

variable "xai_api_key" {
  type      = string
  sensitive = true
  default   = ""
}

variable "gateway_token" {
  type      = string
  sensitive = true
}

# Server config
variable "server_type" {
  type    = string
  default = "cax11"
}

variable "location" {
  type    = string
  default = "nbg1"
}
