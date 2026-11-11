import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Settings live inside the encrypted vault, so they can't be read before unlock. This
 * non-secret marker file mirrors "Browser autofill: off" so the local listener isn't
 * started at all at launch when the user turned it off.
 */
const FLAG = 'browser-autofill-off'

export const browserDisabledOnDisk = (dir: string): boolean => existsSync(join(dir, FLAG))

export function setBrowserDisabledOnDisk(dir: string, disabled: boolean): void {
  const p = join(dir, FLAG)
  if (disabled) writeFileSync(p, 'Browser autofill is turned off in Sentrix settings.\n')
  else if (existsSync(p)) unlinkSync(p)
}
