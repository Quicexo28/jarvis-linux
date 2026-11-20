import { Component, type ReactNode } from 'react'

// Un throw en un visor de canvas (Plan3D, Space, Vault, Plan2D) desmontaba toda
// la app. Aquí se contiene y se pide salir del modo.
export class ModeErrorBoundary extends Component<{ children: ReactNode; onFail: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(err: Error) {
    console.error('[mode] vista caída:', err.message)
    this.props.onFail()
  }
  render() { return this.state.failed ? null : this.props.children }
}
