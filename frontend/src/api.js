// 后端 API 封装（开发期经 vite 代理转发到 :3001）
export async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const detail = data && data.error ? data.error : res.statusText
    throw new Error(detail)
  }
  return data
}
