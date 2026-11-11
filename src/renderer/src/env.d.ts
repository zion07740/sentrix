import type { SentrixApi } from '@shared/types'

declare global {
  interface Window {
    sentrix: SentrixApi
  }
}

export {}
