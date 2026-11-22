// A plugin that sends one datagram to a documentation-range address on the discard port, and closes at once.
import dgram from 'node:dgram'
const socket = dgram.createSocket('udp4')
socket.send('hello', 9, '192.0.2.1', () => { socket.close() })
