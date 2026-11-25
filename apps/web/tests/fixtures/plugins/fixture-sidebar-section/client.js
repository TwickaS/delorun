/**
 * A stand-in plugin section for the sidebar's `sidebar.sections` seat: three invented projects, each folding open onto
 * its sessions. It exists to show, in a picture and in a browser check, that a plugin can put its own tree beside
 * Delorun's chat list instead of replacing the browsing region. It registers nothing else and reads no service.
 */
window.__ModuleLoader__.load({
  id: '@fixture/sidebar-section',
  factory(require) {
    const React = require('react')
    const style = document.createElement('style')
    style.dataset.plugin = '@fixture/sidebar-section'
    style.textContent = [
      '[data-standin-section] { display: flex; flex-direction: column; gap: 2px; padding: 0 0 8px; }',
      '[data-standin-section] > header { display: flex; align-items: center; gap: 6px; padding: 6px 8px 4px;',
      '  font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;',
      '  color: var(--dsw-alias-label-secondary); }',
      '[data-standin-section] ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }',
      '[data-standin-section] button { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 28px;',
      '  padding: 4px 8px; border: none; border-radius: var(--dsw-radius-sm); background: transparent;',
      '  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }',
      '[data-standin-section] button:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '[data-standin-section] button[data-depth="1"] { padding-left: 22px; font-size: 12px;',
      '  color: var(--dsw-alias-label-secondary); }',
      '[data-standin-section] .count { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary); }',
    ].join('\n')
    document.head.append(style)
    const PROJECTS = [
      { id: 'atlas', name: 'Atlas', sessions: ['Schema migration', 'Nightly build'] },
      { id: 'beacon', name: 'Beacon', sessions: ['Release notes'] },
      { id: 'cinder', name: 'Cinder', sessions: ['Flaky spec', 'Cache warm-up', 'Docs pass'] },
    ]
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.sections', () => ctx.slots.register({
          name: 'sidebar.sections', id: 'fixture-sidebar-section', order: 100,
        }, function StandinSection({ wide }) {
          const [open, setOpen] = React.useState(() => new Set(['atlas']))
          // The rail has no room for a tree; one icon button stands for the section there.
          if (!wide) {
            return React.createElement('button', {
              type: 'button', 'data-standin-rail': '', 'aria-label': 'LayerFS projects',
              style: { width: 36, height: 36, border: 'none', borderRadius: 8, background: 'transparent', cursor: 'pointer', color: 'inherit' },
            }, React.createElement('span', { 'aria-hidden': 'true' }, '\u25a6'))
          }
          const toggle = (id) => {
            setOpen((current) => {
              const next = new Set(current)
              if (next.has(id)) next.delete(id)
              else next.add(id)
              return next
            })
          }
          return React.createElement('section', { 'data-standin-section': '', 'aria-label': 'LayerFS projects' },
            React.createElement('header', null, 'LayerFS projects'),
            React.createElement('ul', null, PROJECTS.flatMap(project => [
              React.createElement('li', { key: project.id },
                React.createElement('button', {
                  type: 'button', 'data-standin-project': project.id,
                  'aria-expanded': open.has(project.id), onClick: () => { toggle(project.id) },
                },
                React.createElement('span', { 'aria-hidden': 'true' }, open.has(project.id) ? '\u25be' : '\u25b8'),
                project.name,
                React.createElement('span', { className: 'count' }, String(project.sessions.length)))),
              ...open.has(project.id) ? project.sessions.map(title => React.createElement('li', { key: `${project.id}/${title}` },
                React.createElement('button', { type: 'button', 'data-depth': '1', 'data-standin-session': title }, title))) : [],
            ])))
        }))
      },
    }
  },
})
