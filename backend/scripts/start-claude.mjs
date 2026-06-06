// Cross-platform launcher for the Claude subscription brain.
// Equivalent to setting JARVIS_BRAIN=agent-sdk and starting the server, but
// works the same on Windows / macOS / Linux. Requires a one-time:
//   npm run setup:claude   (installs @anthropic-ai/claude-agent-sdk + zod)
//   claude login           (authenticate with your Claude subscription)
import process from 'node:process'

process.env.JARVIS_BRAIN = process.env.JARVIS_BRAIN || 'agent-sdk'
// Optional: pick a model, e.g. JARVIS_MODEL=claude-sonnet-4-6
await import('../src/server.js')
