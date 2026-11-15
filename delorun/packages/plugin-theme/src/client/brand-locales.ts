/** The brand's copy: the wordmark and the headline of the New Session hero. */

/** English dictionary. */
export const en = {
  'hero.mark': 'Delorun',
  'hero.headline': 'What are we working on?',
}

/** A key of the brand's dictionary. */
export type BrandLocaleKey = keyof typeof en

/** Chinese dictionary. */
// The Chinese wordmark keeps Delorun until the translation pass.
export const zh: Record<BrandLocaleKey, string> = {
  'hero.mark': 'Delorun',
  'hero.headline': '想做点什么？',
}
