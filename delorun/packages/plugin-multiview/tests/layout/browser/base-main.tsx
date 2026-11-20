import { createRoot } from 'react-dom/client'
import { buildPreset, panesOf, type PaneId } from '../../../src/layout/index.ts'

// The bundle-size baseline: React and the layout model and operations, without the Workspace library or the adapter.
createRoot(document.getElementById('root')!).render(<div>{panesOf(buildPreset('grid', 'main' as PaneId, ['a' as PaneId])).join(',')}</div>)
