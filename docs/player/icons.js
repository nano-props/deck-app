// Shared SVG icon factory. Each icon is a function that returns a
// FRESH SVG element — DOM nodes can only have one parent, so callers
// that render multiple instances need a new node each time.

const SVG_NS = 'http://www.w3.org/2000/svg'

function makeSvg(paths, size) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

export const icon = {
  back: (size = 18) => makeSvg(['M19 12H5', 'M12 19l-7-7 7-7'], size),
  deck: (size = 18) => makeSvg(['M4 4h16v16H4z', 'M4 8h16'], size),
  trash: (size = 14) => makeSvg([
    'M3 6h18',
    'M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2',
    'M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6',
  ], size),
}
