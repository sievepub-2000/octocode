import { is64BitArch, spawnExe, normalizePath } from 'cross-spawn-windows-exe'
import path from 'node:path'
import { open } from 'node:fs/promises'

const pairSettings = ['version-string', 'resource-string']
const singleSettings = ['file-version', 'product-version', 'icon', 'requested-execution-level']
const noPrefixSettings = ['application-manifest']

export const rcedit = async (exe, options) => {
  // Fail before launching the resource editor for a missing/non-PE input.
  // In particular, preserve the original file on invalid build input.
  const input = await open(exe, 'r')
  try {
    const signature = Buffer.alloc(2)
    const { bytesRead } = await input.read(signature, 0, 2, 0)
    if (bytesRead !== 2 || signature.toString('ascii') !== 'MZ') {
      throw new Error(`Resource editing requires a Windows PE executable: ${exe}`)
    }
  } finally {
    await input.close()
  }
  if (!options || typeof options !== 'object') throw new TypeError('Resource editing options must be an object')
  const rceditExe = is64BitArch(process.arch) ? 'rcedit-x64.exe' : 'rcedit.exe'
  const rcedit = path.resolve(import.meta.dirname, '..', 'bin', rceditExe)
  const args = [await normalizePath(exe)]

  for (const name of pairSettings) {
    if (options[name]) {
      for (const [key, value] of Object.entries(options[name])) {
        args.push(`--set-${name}`, key, value)
      }
    }
  }

  for (const name of singleSettings) {
    if (options[name]) {
      args.push(`--set-${name}`, options[name])
    }
  }

  for (const name of noPrefixSettings) {
    if (options[name]) {
      args.push(`--${name}`, options[name])
    }
  }

  const spawnOptions = {
    env: { ...process.env }
  }

  await spawnExe(rcedit, args, spawnOptions)
}
