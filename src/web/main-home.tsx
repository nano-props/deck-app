// Home entry — placeholder until Step 6 lands the section components.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { HomePage } from '#/web/pages/HomePage.tsx'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found in index.html')
createRoot(root).render(
  <StrictMode>
    <HomePage />
  </StrictMode>,
)
