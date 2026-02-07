output "server_ipv4" {
  value = hcloud_server.openclaw.ipv4_address
}

output "ssh_command" {
  value = "ssh openclaw@${hcloud_server.openclaw.ipv4_address}"
}

output "tailscale_note" {
  value = "After boot, find Tailscale IP with: ssh openclaw@${hcloud_server.openclaw.ipv4_address} tailscale ip -4"
}
