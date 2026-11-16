/**
 * Handing a written file to the browser as a download.
 * @module @delorun/bundle-local/client/save-file
 */

/** The type a downloaded setup file carries; the file is a ZIP. */
const FILE_TYPE = 'application/zip'

/**
 * Offer bytes to the person as a file download.
 * @param name - the file's name.
 * @param bytes - its contents.
 */
export function saveBrowserFile(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: FILE_TYPE }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}
