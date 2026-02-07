resource "hcloud_ssh_key" "admin" {
  name       = "muavin-${var.instance_name}"
  public_key = var.ssh_public_key
}

resource "hcloud_firewall" "openclaw" {
  name = "${var.instance_name}-fw"

  rule {
    direction = "in"
    protocol  = "tcp"
    port      = "22"
    source_ips = [
      "0.0.0.0/0",
      "::/0"
    ]
  }

  rule {
    direction = "in"
    protocol  = "udp"
    port      = "41641"
    source_ips = [
      "0.0.0.0/0",
      "::/0"
    ]
  }
}

data "cloudinit_config" "openclaw" {
  gzip          = false
  base64_encode = false

  part {
    content_type = "text/cloud-config"
    content = templatefile("${path.module}/cloud-init.yml", {
      ssh_public_key     = var.ssh_public_key
      tailscale_authkey  = var.tailscale_authkey
      instance_name      = var.instance_name
      anthropic_api_key  = var.anthropic_api_key
      openai_api_key     = var.openai_api_key
      gemini_api_key     = var.gemini_api_key
      openrouter_api_key = var.openrouter_api_key
      xai_api_key        = var.xai_api_key
      gateway_token      = var.gateway_token
      openclaw_config_b64 = base64encode(replace(file("${path.module}/../configs/openclaw.json"), "GATEWAY_TOKEN_PLACEHOLDER", var.gateway_token))
    })
  }
}

resource "hcloud_server" "openclaw" {
  name        = var.instance_name
  server_type = var.server_type
  location    = var.location
  image       = "ubuntu-24.04"

  ssh_keys = [hcloud_ssh_key.admin.id]

  firewall_ids = [hcloud_firewall.openclaw.id]

  user_data = data.cloudinit_config.openclaw.rendered

  labels = {
    managed_by = "muavin"
    instance   = var.instance_name
  }
}
