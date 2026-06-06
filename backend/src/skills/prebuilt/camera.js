import { json } from '../../lib/http.js'

export const route = {
  method: 'GET',
  path: '/api/skills/camera',
  handler(_req, res) {
    return json(res, 200, {
      ok: true,
      skill: 'camera',
      action: 'open_camera',
      message: 'Solicita al frontend que active la camara via IPC.',
    })
  },
}
