import { test, expect, beforeEach, vi } from 'vitest'
import { getApiBase, setApiBase, clearApiBase, getMobileToken, setMobileToken, clearMobileToken } from './client'

const STORAGE_KEY = 'jarvis.api.base'
const DEFAULT_BASE = 'http://127.0.0.1:8788'

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

test('getApiBase returns default when nothing stored', () => {
  expect(getApiBase()).toBe(DEFAULT_BASE)
})

test('setApiBase persists the URL', () => {
  setApiBase('http://192.168.1.10:9000')
  expect(localStorage.getItem(STORAGE_KEY)).toBe('http://192.168.1.10:9000')
})

test('getApiBase returns stored URL after setApiBase', () => {
  setApiBase('http://192.168.1.10:9000')
  expect(getApiBase()).toBe('http://192.168.1.10:9000')
})

test('clearApiBase removes stored URL', () => {
  setApiBase('http://192.168.1.10:9000')
  clearApiBase()
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
})

test('getApiBase returns default after clearApiBase', () => {
  setApiBase('http://192.168.1.10:9000')
  clearApiBase()
  expect(getApiBase()).toBe(DEFAULT_BASE)
})

test('getApiBase trims trailing slash', () => {
  setApiBase('http://192.168.1.10:9000/')
  expect(getApiBase()).toBe('http://192.168.1.10:9000')
})

test('getMobileToken returns null when nothing stored', () => {
  expect(getMobileToken()).toBeNull()
})

test('setMobileToken stores token and getMobileToken retrieves it', () => {
  setMobileToken('abc123')
  expect(getMobileToken()).toBe('abc123')
})

test('clearMobileToken removes stored token', () => {
  setMobileToken('abc123')
  clearMobileToken()
  expect(getMobileToken()).toBeNull()
})
