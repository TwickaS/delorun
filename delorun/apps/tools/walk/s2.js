await page.setViewportSize({ width: 390, height: 844 })
await page.waitForTimeout(1000)
const heads = []
for (const n of ['b-look', 'c-models', 'd-agents']) {
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.waitForTimeout(900)
  await shot(n, 22)
  heads.push(await page.evaluate(() => document.body.innerText.slice(0, 160).replace(/\n/g, ' | ')))
}
console.log(heads.join('\n'))
