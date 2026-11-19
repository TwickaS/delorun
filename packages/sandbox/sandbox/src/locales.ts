/** Locale-owned sandbox approval text; audit inputs remain verbatim. */

/** English escalation messages. */
export const en = {
  afterFault: "Delorun's sandbox had a problem; this asks to run without it.",
  escalation: (mode: string, justification: string): string => `Allow this operation with ${mode} permissions: ${justification}`,
}

/** Chinese escalation messages. */
export const zh = {
  afterFault: 'Delorun 的沙盒出了问题；此请求要求不使用沙盒运行。',
  escalation: (mode: string, justification: string): string => `允许本次操作使用 ${mode} 权限：${justification}`,
} satisfies typeof en

/** Japanese escalation messages. */
export const ja = {
  afterFault: 'Delorun のサンドボックスに問題が発生しました。このリクエストはサンドボックスなしでの実行を求めています。',
  escalation: (mode: string, justification: string): string => `${mode} 権限でこの操作を許可します：${justification}`,
} satisfies typeof en

/** Spanish dictionary, checked against the English keys. */
export const es = {
  afterFault: 'El sandbox de Delorun tuvo un problema; esta solicitud pide ejecutar sin él.',
  escalation: (mode: string, justification: string): string => `Permitir esta operación con permisos ${mode}: ${justification}`,
} satisfies typeof en

/** French dictionary, checked against the English keys. */
export const fr = {
  afterFault: "Le bac à sable de Delorun a rencontré un problème ; cette demande exige d'exécuter sans lui.",
  escalation: (mode: string, justification: string): string => `Autoriser cette opération avec les permissions ${mode} : ${justification}`,
} satisfies typeof en

/** German dictionary, checked against the English keys. */
export const de = {
  afterFault: 'Die Sandbox von Delorun hatte ein Problem; diese Anfrage bittet darum, ohne sie auszuführen.',
  escalation: (mode: string, justification: string): string => `Diesen Vorgang mit ${mode}-Berechtigungen zulassen: ${justification}`,
} satisfies typeof en

/** Russian dictionary, checked against the English keys. */
export const ru = {
  afterFault: 'У песочницы Delorun возникла проблема; этот запрос просит выполнить без неё.',
  escalation: (mode: string, justification: string): string => `Разрешить эту операцию с правами ${mode}: ${justification}`,
} satisfies typeof en

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  afterFault: 'O sandbox do Delorun teve um problema; este pedido solicita executar sem ele.',
  escalation: (mode: string, justification: string): string => `Permitir esta operação com permissões ${mode}: ${justification}`,
} satisfies typeof en

/** Localized text type shared by the approval request's `displayReason` and `notice`. */
type Localized = Record<'en' | 'zh' | 'ja' | 'es' | 'fr' | 'de' | 'ru' | 'pt', string>

/**
 * Build translations for the existing Client localized-text resolver.
 * @param mode - requested sandbox mode.
 * @param justification - raw model justification, preserved in every translation.
 * @returns localized approval text.
 */
export function escalationDisplayReason(mode: string, justification: string): Localized {
  return {
    en: en.escalation(mode, justification),
    zh: zh.escalation(mode, justification),
    ja: ja.escalation(mode, justification),
    es: es.escalation(mode, justification),
    fr: fr.escalation(mode, justification),
    de: de.escalation(mode, justification),
    ru: ru.escalation(mode, justification),
    pt: pt.escalation(mode, justification),
  }
}

/**
 * The line an approval card shows when a full-access request follows a temporary sandbox fault.
 * @returns localized notice text, separate from the model's justification.
 */
export function sandboxFaultNotice(): Localized {
  return {
    en: en.afterFault,
    zh: zh.afterFault,
    ja: ja.afterFault,
    es: es.afterFault,
    fr: fr.afterFault,
    de: de.afterFault,
    ru: ru.afterFault,
    pt: pt.afterFault,
  }
}
