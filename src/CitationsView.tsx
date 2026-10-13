import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, DoorOpen, LoaderCircle, Pencil, Search, Send, Trash2, UserRound, X } from 'lucide-react'

type Page<T> = { items: T[]; page: number; page_size: number; total: number; pages: number }
type Guardian = { id: number; full_name: string; document_id: string }
type Citation = { id: number; guardian_id: number; guardian_name: string; guardian_document: string; student_names: string; student_documents: string; scheduled_at: string; reason: string; status: string; guardian_confirmed: boolean }
type ViewMode = 'today' | 'history'

function localDateTime(value: string | Date) {
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function PageControls({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (page: number) => void }) {
  return <div className="directory-pagination"><span>{total} citaciones · página {page} de {Math.max(pages, 1)}</span><div><button className="icon-button" aria-label="Página anterior" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft size={18} /></button><button className="icon-button" aria-label="Página siguiente" disabled={page >= pages} onClick={() => onPage(page + 1)}><ChevronRight size={18} /></button></div></div>
}

function GuardianSearch({ token, onSelect, initial }: { token: string; onSelect: (guardian: Guardian | null) => void; initial?: Guardian | null }) {
  const [query, setQuery] = useState(initial ? `${initial.full_name} · C.I. ${initial.document_id}` : '')
  const [results, setResults] = useState<Guardian[]>([])
  const [selected, setSelected] = useState<Guardian | null>(initial ?? null)

  useEffect(() => {
    const term = query.trim()
    if (selected || term.length < 2) {
      setResults([])
      return
    }
    const timer = window.setTimeout(() => {
      fetch(`/api/guardians?q=${encodeURIComponent(term)}&page=1&page_size=8`, { headers: { Authorization: `Bearer ${token}` } })
        .then(async (response) => {
          const data: Page<Guardian> = await response.json()
          if (!response.ok) throw new Error('No se pudieron buscar representantes.')
          setResults(data.items)
        })
        .catch(() => setResults([]))
    }, 180)
    return () => window.clearTimeout(timer)
  }, [query, selected, token])

  function choose(guardian: Guardian) {
    setSelected(guardian)
    setQuery(`${guardian.full_name} · C.I. ${guardian.document_id}`)
    setResults([])
    onSelect(guardian)
  }

  return <div className="guardian-picker"><label className="field-label">Representante<input value={query} onChange={(event) => { setQuery(event.target.value); setSelected(null); onSelect(null) }} placeholder="Busca por nombre o documento" autoComplete="off" /></label>{selected && <button type="button" className="guardian-clear" onClick={() => { setSelected(null); setQuery(''); onSelect(null) }}><X size={14} />Cambiar representante</button>}{results.length > 0 && <div className="guardian-results">{results.map((guardian) => <button type="button" key={guardian.id} onClick={() => choose(guardian)}><UserRound size={16} /><span><strong>{guardian.full_name}</strong><small>C.I. {guardian.document_id}</small></span></button>)}</div>}{query.trim().length >= 2 && !selected && results.length === 0 && <small className="guardian-no-results">No se encontraron representantes.</small>}</div>
}

function CitationsView({ token, role }: { token: string; role: string }) {
  const [mode, setMode] = useState<ViewMode>('today')
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [guardianId, setGuardianId] = useState<number | null>(null)
  const [guardianName, setGuardianName] = useState('')
  const [reload, setReload] = useState(0)
  const [citations, setCitations] = useState<Page<Citation>>({ items: [], page: 1, page_size: 10, total: 0, pages: 0 })
  const [selectedGuardian, setSelectedGuardian] = useState<Guardian | null>(null)
  const [editCitation, setEditCitation] = useState<Citation | null>(null)
  const [formMessage, setFormMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const canSchedule = role === 'admin' || role === 'coordinator'
  const canManage = canSchedule
  const scheduleDefault = localDateTime(new Date(Date.now() + 86_400_000))

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ page: String(page), page_size: '10' })
      if (search.trim()) query.set('q', search.trim())
      if (guardianId !== null) query.set('guardian_id', String(guardianId))
      else if (mode === 'today') query.set('day', new Date().toLocaleDateString('en-CA'))
      fetch(`/api/citations?${query}`, { headers: { Authorization: `Bearer ${token}` } })
        .then(async (response) => {
          const data: Page<Citation> = await response.json()
          if (!response.ok) throw new Error('No se pudo cargar la agenda de citaciones.')
          setCitations(data)
        })
        .catch((error: Error) => setFormMessage(error.message))
    }, 160)
    return () => window.clearTimeout(timer)
  }, [guardianId, mode, page, reload, search, token])

  async function submitCitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    if (!selectedGuardian) {
      setFormMessage('Busca y selecciona un representante.')
      return
    }
    setBusy(true)
    setFormMessage('')
    try {
      const response = await fetch('/api/citations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ guardian_id: selectedGuardian.id, scheduled_at: new Date(String(form.get('scheduled_at'))).toISOString(), reason: form.get('reason') }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'No se pudo agendar la citación.')
      setSelectedGuardian(null)
      formElement.reset()
      setFormMessage('Citación agendada. Se envió el aviso al representante si tiene Telegram vinculado.')
      setPage(1)
      setReload((value) => value + 1)
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : 'No se pudo agendar la citación.')
    } finally { setBusy(false) }
  }

  async function updateStatus(id: number, status: string) {
    const response = await fetch(`/api/citations/${id}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ status }) })
    if (response.ok) setCitations((current) => ({ ...current, items: current.items.map((item) => item.id === id ? { ...item, status } : item) }))
  }

  async function cancelCitation(id: number) {
    if (!window.confirm('¿Cancelar esta citación? Se conservará en el historial como cancelada.')) return
    const response = await fetch(`/api/citations/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    if (response.ok) setCitations((current) => ({ ...current, items: current.items.map((item) => item.id === id ? { ...item, status: 'cancelled' } : item) }))
    else setFormMessage('No se pudo cancelar la citación.')
  }

  function openGuardianHistory(item: Citation) {
    setGuardianId(item.guardian_id)
    setGuardianName(item.guardian_name)
    setMode('history')
    setPage(1)
  }

  return <section className="content-wrap citation-page">
    <div className="page-heading"><div><p className="eyebrow">PORTERÍA · AGENDA</p><h1>{guardianId !== null ? `Citaciones · ${guardianName}` : 'Citaciones'}</h1><p className="page-subtitle">Agenda diaria y todo el historial, con búsqueda por representante o alumno.</p></div>{guardianId !== null && <button className="secondary-button" onClick={() => { setGuardianId(null); setGuardianName(''); setPage(1) }}>Ver todas</button>}</div>
    {!guardianId && <div className="citation-modes" role="tablist" aria-label="Período de citaciones"><button type="button" role="tab" aria-selected={mode === 'today'} className={mode === 'today' ? 'active' : ''} onClick={() => { setMode('today'); setPage(1) }}><CalendarDays size={16} />Hoy</button><button type="button" role="tab" aria-selected={mode === 'history'} className={mode === 'history' ? 'active' : ''} onClick={() => { setMode('history'); setPage(1) }}><Clock3 size={16} />Historial</button></div>}
    {canSchedule && !guardianId && <form className="citation-scheduler" onSubmit={submitCitation}><div className="section-title"><span className="step-number"><CalendarDays size={14} /></span><div><h2>Agendar representante</h2><p>Elige un horario disponible; se bloquean las citas duplicadas.</p></div></div><div className="scheduler-fields"><GuardianSearch token={token} onSelect={setSelectedGuardian} /><label className="field-label">Fecha y hora<input name="scheduled_at" type="datetime-local" required defaultValue={scheduleDefault} /></label><label className="field-label">Motivo<input name="reason" required minLength={3} maxLength={2000} placeholder="Motivo de la citación" /></label><button className="submit-button" type="submit" disabled={busy || !selectedGuardian}>{busy ? <LoaderCircle className="spin" size={17} /> : <Send size={16} />}Agendar cita</button></div>{formMessage && <p className="form-message" role="status">{formMessage}</p>}</form>}
    <label className="agenda-search"><Search size={18} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder="Buscar representante, cédula o estudiante" /></label>
    <div className="citation-list">{citations.items.map((item) => <article className="citation-card" key={item.id}><div className="citation-info"><span className="citation-time">{new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(item.scheduled_at))}</span><span><button type="button" className="citation-guardian-link" onClick={() => openGuardianHistory(item)}>{item.guardian_name}</button><small>{item.student_names} · C.I. {item.guardian_document}</small><small>{item.reason}</small></span><span className={`citation-status status-${item.status}`}>{item.status === 'pending' ? 'Pendiente' : item.status === 'attended' ? 'Atendido' : item.status === 'no_show' ? 'No asistió' : 'Cancelada'}</span></div><div className="citation-actions"><button onClick={() => openGuardianHistory(item)}><Clock3 size={15} />Historial</button>{item.status === 'pending' && role === 'doorman' && <><button onClick={() => updateStatus(item.id, 'attended')}><Check size={15} />Atendido</button><button onClick={() => updateStatus(item.id, 'no_show')}><X size={15} />No asistió</button></>}{canManage && item.status !== 'cancelled' && <><button onClick={() => setEditCitation(item)}><Pencil size={15} />Editar</button><button onClick={() => void cancelCitation(item.id)}><Trash2 size={15} />Cancelar</button></>}</div></article>)}{citations.items.length === 0 && <div className="empty-state schedule-empty"><DoorOpen size={30} /><strong>{search ? 'No hay coincidencias' : 'Sin citaciones en esta vista'}</strong><span>{search ? 'Prueba otro nombre o documento.' : mode === 'today' ? 'No hay representantes citados hoy.' : 'Aún no hay citaciones históricas.'}</span></div>}</div>
    <PageControls page={citations.page} pages={citations.pages} total={citations.total} onPage={setPage} />
    {editCitation && <CitationEditor item={editCitation} token={token} onClose={() => setEditCitation(null)} onSaved={() => { setEditCitation(null); setPage(1); setReload((value) => value + 1) }} />}
  </section>
}

function CitationEditor({ item, token, onClose, onSaved }: { item: Citation; token: string; onClose: () => void; onSaved: () => void }) {
  const [guardian, setGuardian] = useState<Guardian | null>({ id: item.guardian_id, full_name: item.guardian_name, document_id: item.guardian_document })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    if (!guardian) { setError('Selecciona un representante.'); return }
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/citations/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ guardian_id: guardian.id, scheduled_at: new Date(String(form.get('scheduled_at'))).toISOString(), reason: form.get('reason') }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'No se pudo actualizar la citación.')
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo actualizar la citación.') }
    finally { setBusy(false) }
  }

  return <div className="admin-modal-backdrop" role="presentation" onClick={onClose}><section className="admin-editor-modal" role="dialog" aria-modal="true" aria-labelledby="citation-edit-title" onClick={(event) => event.stopPropagation()}><div className="admin-editor-heading"><div><p className="eyebrow">AGENDA</p><h2 id="citation-edit-title">Editar citación</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Cerrar"><X size={19} /></button></div><form className="admin-form-panel" onSubmit={save}><GuardianSearch token={token} initial={guardian} onSelect={setGuardian} /><label className="field-label">Fecha y hora<input name="scheduled_at" type="datetime-local" required defaultValue={localDateTime(item.scheduled_at)} /></label><label className="field-label">Motivo<input name="reason" required minLength={3} defaultValue={item.reason} /></label>{error && <p className="form-message" role="alert">{error}</p>}<div className="admin-editor-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button><button className="submit-button" disabled={busy}>{busy ? 'Guardando…' : 'Guardar cambios'}</button></div></form></section></div>
}

export default CitationsView
