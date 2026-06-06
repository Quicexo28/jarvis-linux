import { test, expect } from 'vitest'
import { parseNetDev } from '../src/handlers/telemetry.js'

const SAMPLE = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  184836    1842    0    0    0     0          0         0   184836    1842    0    0    0     0       0          0
  eth0: 123456789  12345    0    0    0     0          0        0  987654321  9876    0    0    0     0       0          0`

test('parseNetDev sums rx bytes across all interfaces', () => {
  const { totalRx } = parseNetDev(SAMPLE)
  expect(totalRx).toBe(184836 + 123456789)
})

test('parseNetDev sums tx bytes across all interfaces', () => {
  const { totalTx } = parseNetDev(SAMPLE)
  expect(totalTx).toBe(184836 + 987654321)
})

test('parseNetDev returns zeros for header-only content', () => {
  const { totalRx, totalTx } = parseNetDev('Inter-|\n face |\n')
  expect(totalRx).toBe(0)
  expect(totalTx).toBe(0)
})

test('parseNetDev handles interface names without leading spaces', () => {
  const compact = `Inter-|\n face |\nwlan0:99    1    0    0    0     0          0         0   77    1    0    0    0     0       0          0`
  const { totalRx, totalTx } = parseNetDev(compact)
  expect(totalRx).toBe(99)
  expect(totalTx).toBe(77)
})
