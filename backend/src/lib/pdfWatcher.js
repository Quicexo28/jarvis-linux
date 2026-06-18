import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'fs'
import { join, basename, extname } from 'path'
import { createRequire } from 'module'
import { getVaultPath, isConfigured } from './obsidian.js'

const require = createRequire(import.meta.url)
const { PDFParse, VerbosityLevel } = require('pdf-parse')

let watcher = null

// --- converters ---

async function convertPdf(pdfPath) {
  const buf = readFileSync(pdfPath)
  const parser = new PDFParse({ data: new Uint8Array(buf), verbosity: VerbosityLevel.ERRORS })
  const result = await parser.getText()
  const text = result.text?.trim() || ''
  await parser.destroy()
  return text
}

async function convertDocx(docxPath) {
  const mammoth = (await import('mammoth')).default
  const result = await mammoth.extractRawText({ path: docxPath })
  return result.value?.trim() || ''
}

async function convertImage(imgPath) {
  const Tesseract = (await import('tesseract.js')).default
  const { data } = await Tesseract.recognize(imgPath, 'spa+eng', { logger: () => {} })
  return data.text?.trim() || ''
}

const CONVERTERS = {
  '.pdf':  { fn: convertPdf,   label: 'pdf'  },
  '.docx': { fn: convertDocx,  label: 'docx' },
  '.jpg':  { fn: convertImage, label: 'image' },
  '.jpeg': { fn: convertImage, label: 'image' },
  '.png':  { fn: convertImage, label: 'image' },
}

// --- main handler ---

async function convertFile(filePath) {
  const ext = extname(filePath).toLowerCase()
  const converter = CONVERTERS[ext]
  if (!converter) return

  const mdPath = filePath.replace(new RegExp(`\\${ext}$`, 'i'), '.md')
  if (existsSync(mdPath)) {
    console.log(`[vaultWatcher] skip — .md exists: ${mdPath}`)
    return
  }

  let text
  try {
    text = await converter.fn(filePath)
  } catch (e) {
    console.error(`[vaultWatcher] parse error (${ext}): ${filePath}`, e.message)
    return
  }

  const title = basename(filePath, ext)
  const content = `---\ntype: documento\nsource: ${basename(filePath)}\nformat: ${converter.label}\nconverted_by: jarvis-vault-watcher\n---\n\n# ${title}\n\n${text}\n`

  try {
    writeFileSync(mdPath, content, 'utf-8')
    console.log(`[vaultWatcher] converted: ${mdPath}`)
  } catch (e) {
    console.error(`[vaultWatcher] write error: ${mdPath}`, e.message)
    return
  }

  try {
    unlinkSync(filePath)
    console.log(`[vaultWatcher] deleted: ${filePath}`)
  } catch (e) {
    console.error(`[vaultWatcher] delete error: ${filePath}`, e.message)
  }
}

// --- watcher lifecycle ---

export async function startPdfWatcher() {
  if (!isConfigured()) return
  const vault = getVaultPath()

  const { default: chokidar } = await import('chokidar')
  const GLOB = '**/*.{pdf,docx,jpg,jpeg,png}'

  watcher = chokidar.watch(GLOB, {
    cwd: vault,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
  })

  watcher.on('add', (relPath) => {
    const full = join(vault, relPath)
    console.log(`[vaultWatcher] new file: ${full}`)
    convertFile(full).catch((e) => console.error('[vaultWatcher]', e.message))
  })

  console.log(`[vaultWatcher] watching ${vault} for PDF/DOCX/image files`)
}

export function stopPdfWatcher() {
  watcher?.close()
  watcher = null
}
