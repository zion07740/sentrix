import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Entry, EntrySummary, EntryType } from '@shared/types'
import { Icon, Logo, type IconName } from '../components/Icon'
import { Favicon } from '../components/ui'
import { EntryEditor, EntryView } from './Entry'
import { GeneratorPanel } from './Generator'
import { SettingsScreen } from './Settings'

const api = window.sentrix

type Filter = 'all' | 'favorites' | 'login' | 'note' | 'trash'
type View = 'items' | 'generator' | 'settings'

const FILTERS: Array<{ id: Filter; label: string; icon: IconName }> = [
  { id: 'all', label: 'All items', icon: 'grid' },
  { id: 'favorites', label: 'Favorites', icon: 'star' },
  { id: 'login', label: 'Logins', icon: 'key' },
  { id: 'note', label: 'Secure notes', icon: 'note' },
  { id: 'trash', label: 'Trash', icon: 'trash' }
]

export function VaultScreen({ onLock }: { onLock: () => void }) {
  const [items, setItems] = useState<EntrySummary[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [view, setView] = useState<View>('items')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Entry | null>(null)
  const [editing, setEditing] = useState<{ type: EntryType; entry: Entry | null } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const load = useCallback(() => api.vault.list().then(setItems).catch(() => undefined), [])

  useEffect(() => {
    load()
    return api.on('vault-changed', load)
  }, [load])

  useEffect(() => {
    if (!selectedId) return setSelected(null)
    api.vault.get(selectedId).then(setSelected)
  }, [selectedId, items])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return
      const k = e.key.toLowerCase()
      if (k === 'f') {
        e.preventDefault()
        setView('items')
        setTimeout(() => searchRef.current?.focus())
      } else if (k === 'n') {
        e.preventDefault()
        setView('items')
        setEditing({ type: 'login', entry: null })
      } else if (k === 'l') {
        e.preventDefault()
        onLock()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onLock])

  const counts = useMemo(() => {
    const live = items.filter((i) => i.trashedAt === null)
    return {
      all: live.length,
      favorites: live.filter((i) => i.favorite).length,
      login: live.filter((i) => i.type === 'login').length,
      note: live.filter((i) => i.type === 'note').length,
      trash: items.length - live.length
    }
  }, [items])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items
      .filter((i) => (filter === 'trash' ? i.trashedAt !== null : i.trashedAt === null))
      .filter((i) => (filter === 'favorites' ? i.favorite : filter === 'login' || filter === 'note' ? i.type === filter : true))
      .filter((i) => !q || [i.title, i.username, i.host, ...i.tags].some((s) => s.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
  }, [items, filter, query])

  const startNew = (type: EntryType) => {
    setView('items')
    setSelectedId(null)
    setEditing({ type, entry: null })
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Logo size={26} />
          <span>Sentrix</span>
        </div>
        <button className="btn primary block new-btn" onClick={() => startNew('login')}>
          <Icon name="plus" size={16} /> New login
        </button>
        <nav>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={`nav-item${view === 'items' && filter === f.id ? ' active' : ''}`}
              onClick={() => {
                setView('items')
                setFilter(f.id)
                setEditing(null)
              }}
            >
              <Icon name={f.icon} size={17} />
              <span>{f.label}</span>
              <span className="count">{counts[f.id]}</span>
            </button>
          ))}
          <div className="nav-sep" />
          <button className={`nav-item${view === 'generator' ? ' active' : ''}`} onClick={() => setView('generator')}>
            <Icon name="wand" size={17} />
            <span>Generator</span>
          </button>
          <button className={`nav-item${view === 'settings' ? ' active' : ''}`} onClick={() => setView('settings')}>
            <Icon name="settings" size={17} />
            <span>Settings</span>
          </button>
        </nav>
        <button className="nav-item lock-btn" onClick={onLock} title="Lock (Ctrl+L)">
          <Icon name="lock" size={17} />
          <span>Lock</span>
          <kbd>Ctrl L</kbd>
        </button>
      </aside>

      {view === 'generator' && (
        <main className="page">
          <GeneratorPanel standalone />
        </main>
      )}
      {view === 'settings' && (
        <main className="page">
          <SettingsScreen />
        </main>
      )}
      {view === 'items' && (
        <>
          <section className="list-pane">
            <div className="search">
              <Icon name="search" size={16} />
              <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search vault  (Ctrl F)" spellCheck={false} />
              {query && (
                <button className="clear" onClick={() => setQuery('')} aria-label="Clear search">
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>
            <div className="list-head">
              <span>{FILTERS.find((f) => f.id === filter)?.label}</span>
              {filter === 'trash' && counts.trash > 0 ? (
                <button
                  className="link danger"
                  onClick={async () => {
                    if (confirm(`Permanently delete ${counts.trash} item(s) in the trash? This cannot be undone.`)) {
                      await api.vault.emptyTrash()
                      setSelectedId(null)
                    }
                  }}
                >
                  Empty trash
                </button>
              ) : (
                filter !== 'trash' && (
                  <button className="link" onClick={() => startNew('note')}>
                    + Note
                  </button>
                )
              )}
            </div>
            <ul className="list" role="listbox">
              {visible.map((i) => (
                <li key={i.id}>
                  <button
                    className={`row${selectedId === i.id ? ' selected' : ''}`}
                    onClick={() => {
                      setEditing(null)
                      setSelectedId(i.id)
                    }}
                    role="option"
                    aria-selected={selectedId === i.id}
                  >
                    {i.type === 'note' ? (
                      <span className="favicon note">
                        <Icon name="note" size={18} />
                      </span>
                    ) : (
                      <Favicon host={i.host} title={i.title} />
                    )}
                    <span className="row-text">
                      <span className="row-title">{i.title}</span>
                      <span className="row-sub">{i.type === 'note' ? 'Secure note' : i.username || i.host || '—'}</span>
                    </span>
                    {i.favorite && <Icon name="star" size={14} className="star" />}
                  </button>
                </li>
              ))}
              {visible.length === 0 && (
                <li className="empty">
                  {query ? 'No matches.' : filter === 'trash' ? 'Trash is empty.' : items.length === 0 ? 'Your vault is empty. Add your first login, or import from Settings.' : 'Nothing here yet.'}
                </li>
              )}
            </ul>
          </section>

          <main className="detail-pane">
            {editing ? (
              <EntryEditor
                key={editing.entry?.id ?? `new-${editing.type}`}
                type={editing.type}
                entry={editing.entry}
                onCancel={() => setEditing(null)}
                onSaved={(e) => {
                  setEditing(null)
                  setSelectedId(e.id)
                  load()
                }}
              />
            ) : selected ? (
              <EntryView
                key={selected.id}
                entry={selected}
                onEdit={() => setEditing({ type: selected.type, entry: selected })}
                onChanged={load}
                onDeleted={() => {
                  setSelectedId(null)
                  load()
                }}
              />
            ) : (
              <div className="placeholder">
                <Logo size={64} />
                <p>Select an item, or press <kbd>Ctrl N</kbd> to add a login.</p>
              </div>
            )}
          </main>
        </>
      )}
    </div>
  )
}
