import { ProxyAgent, setGlobalDispatcher } from 'undici'

const inDocker = process.env.WORKSPACE_ROOT === '/app'
const localProxy = inDocker ? 'http://host.docker.internal:7897' : 'http://127.0.0.1:7897'
const proxyUrl = process.env.MARKET_PROXY_URL || (process.platform === 'win32'
  ? localProxy
  : process.env.HTTPS_PROXY || process.env.HTTP_PROXY || localProxy)

if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl))
  console.log(`[network] HTTP proxy enabled: ${proxyUrl.replace(/:\/\/[^@]+@/, '://***@')}`)
}
