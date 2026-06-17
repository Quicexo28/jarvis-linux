import { create } from 'zustand'

/**
 * Passphrase store — drives the PassphraseOverlay, a modal that asks the owner
 * to type the code-change permission password. The backend requests it over the
 * skill bus (`request_passphrase`) before running any self-coding action; the
 * primitive resolves once the owner submits or cancels.
 *
 * Only one request is outstanding at a time. A new request supersedes the
 * previous one (the old promise rejects with 'superseded').
 */

interface PendingRequest {
  reason: string
  resolve: (passphrase: string) => void
  reject: (err: Error) => void
}

interface PassphraseState {
  pending: PendingRequest | null
  /** Open the modal and resolve with the typed passphrase (or reject on cancel). */
  request: (reason: string) => Promise<string>
  submit: (passphrase: string) => void
  cancel: () => void
}

export const usePassphraseStore = create<PassphraseState>((set, get) => ({
  pending: null,
  request: (reason) =>
    new Promise<string>((resolve, reject) => {
      const prev = get().pending
      if (prev) prev.reject(new Error('superseded'))
      set({ pending: { reason, resolve, reject } })
    }),
  submit: (passphrase) => {
    const p = get().pending
    if (!p) return
    set({ pending: null })
    p.resolve(passphrase)
  },
  cancel: () => {
    const p = get().pending
    if (!p) return
    set({ pending: null })
    p.reject(new Error('cancelled'))
  },
}))
