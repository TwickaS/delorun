// A plugin that fetches a URL it declares (here a server of its own on the loopback address) and listens briefly.
import http from 'node:http'
const server = http.createServer((_request, response) => { response.end('ok') })
server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address()
  const response = await fetch(`http://127.0.0.1:${port}/declared`)
  console.log(await response.text())
  server.close()
})
