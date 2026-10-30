import { createServer } from 'node:net'

export async function canBindLocalFixture(): Promise<boolean> {
  return await new Promise(resolve => {
    const server = createServer()
    const fail = (): void => {
      server.close()
      resolve(false)
    }
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}
