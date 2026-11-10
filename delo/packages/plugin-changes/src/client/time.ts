/**
 * @param iso - an ISO 8601 time.
 * @returns the time of day in the page's language, hours and minutes.
 */
export function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
