const out = {}
const shot = async (name, quality = 30) => {
  const buf = await page.screenshot({ type: 'jpeg', quality })
  out[name] = buf.toString('base64').match(/.{1,3000}/g)
}
await page.setViewportSize({ width: 390, height: 844 })
await shot('a-now')
return out
