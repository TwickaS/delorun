/** Default Unix sockets and socket directories a confined command cannot reach when it shares the host's network. */

/** The default `networkDeniedSockets` config field. */
export const NETWORK_DENIED_SOCKETS: readonly string[] = ['/run/dbus/system_bus_socket', '/run/tailscale/tailscaled.sock', '/run/snapd.socket', '/run/snapd-snap.socket']

/** The default `networkDeniedSocketDirectories` config field. */
export const NETWORK_DENIED_SOCKET_DIRECTORIES: readonly string[] = ['/run/systemd/resolve', '/run/nscd', '/run/avahi-daemon', '/run/cups']
