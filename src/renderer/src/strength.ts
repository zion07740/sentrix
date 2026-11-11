import { ZxcvbnFactory, type ZxcvbnResult } from '@zxcvbn-ts/core'
import * as common from '@zxcvbn-ts/language-common'
import * as en from '@zxcvbn-ts/language-en'

let factory: ZxcvbnFactory | null = null

export function strength(password: string, userInputs: string[] = []): ZxcvbnResult {
  factory ??= new ZxcvbnFactory({
    translations: en.translations,
    graphs: common.adjacencyGraphs,
    dictionary: { ...common.dictionary, ...en.dictionary }
  })
  return factory.check(password.slice(0, 256), userInputs)
}

export const SCORE_LABEL = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'] as const
