/** The copy of the General row that brings Delorun's look back. */

/** English dictionary. */
export const en = {
  'title': 'Delorun look',
  'description': "Use Delorun's look and add-ons instead of the original look.",
  'saveFailed': 'Could not save this. Try again.',
}

/** A key of the row's dictionary. */
export type LookLocaleKey = keyof typeof en

/** Chinese dictionary. */
export const zh: Record<LookLocaleKey, string> = {
  'title': 'Delorun 外观',
  'description': '使用 Delorun 的外观和附加功能，而不是原版外观。',
  'saveFailed': '无法保存，请重试。',
}
