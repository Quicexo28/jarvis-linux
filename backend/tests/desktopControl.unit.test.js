import { describe, it, expect } from 'vitest'
import { pickPlayer, matchWindow } from '../src/handlers/desktopControl.js'

describe('pickPlayer', () => {
  it('prefers a local player over the phone proxies from KDE Connect', () => {
    expect(pickPlayer([
      { name: 'kdeconnect.mpris_1a4e', status: 'Playing' },
      { name: 'spotify', status: 'Paused' },
    ])).toBe('spotify')
  })

  it('prefers whatever local player is playing', () => {
    expect(pickPlayer([
      { name: 'spotify', status: 'Paused' },
      { name: 'firefox.instance_1', status: 'Playing' },
    ])).toBe('firefox.instance_1')
  })

  it('falls back to a remote player, and to nothing', () => {
    expect(pickPlayer([{ name: 'kdeconnect.mpris_x', status: 'Stopped' }])).toBe('kdeconnect.mpris_x')
    expect(pickPlayer([])).toBeNull()
  })
})

describe('matchWindow', () => {
  const clients = [
    { class: 'Alacritty', title: 'claude', focusHistoryID: 3, address: '0x1', workspace: { name: '2' } },
    { class: 'brave-browser', title: 'Física — YouTube', focusHistoryID: 1, address: '0x2', workspace: { name: '1' } },
    { class: 'Alacritty', title: 'htop', focusHistoryID: 0, address: '0x3', workspace: { name: '3' } },
    { class: '', title: 'fantasma', address: '0x4' },
  ]

  it('matches by class, most recently focused first', () => {
    expect(matchWindow(clients, 'alacritty').address).toBe('0x3')
  })

  it('falls back to the title, ignoring accents', () => {
    expect(matchWindow(clients, 'fisica').address).toBe('0x2')
  })

  it('returns null when nothing matches or the target is empty', () => {
    expect(matchWindow(clients, 'spotify')).toBeNull()
    expect(matchWindow(clients, '  ')).toBeNull()
  })
})
