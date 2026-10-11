import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const here = path.dirname(fileURLToPath(import.meta.url))
const svg = await readFile(path.join(here, 'logo.svg'))

const outDir = path.join(here, 'out')
await mkdir(outDir, { recursive: true })

const sizes = [512, 256, 192, 64, 48, 32, 16]
for (const size of sizes) {
  await sharp(svg, { density: 384 })
    .resize(size, size)
    .png()
    .toFile(path.join(outDir, `logo-${size}.png`))
}

// site logo: single opaque badge works on light & dark backgrounds
await writeFile(
  'C:/work_file/API-Bridge-Hub/new-api-main/web/public/logo.png',
  await readFile(path.join(outDir, 'logo-512.png'))
)

// favicon: classic multi-size ICO
const icoSizes = [16, 32, 48, 64]
const icoPngs = await Promise.all(
  icoSizes.map((s) => sharp(svg, { density: 384 }).resize(s, s).png().toBuffer())
)
const ico = await pngToIco(icoPngs)
await writeFile(
  'C:/work_file/API-Bridge-Hub/new-api-main/web/public/favicon.ico',
  ico
)

console.log('logo.png + favicon.ico written')
