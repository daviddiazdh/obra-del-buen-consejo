import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { ChevronLeft, ChevronRight, Pencil, Search, Trash2, X } from 'lucide-react'

type Report = {
  id: number
  severity: string
  description: string
  action_taken: string | null
  occurred_at: string
  created_at: string
  subject: string | null
  location: string | null
  active: boolean
  student_ids: number[]
  student_names: string
  student_documents: string
  students?: ReportStudent[]
}
type Page = { items: Report[]; page: number; page_size: number; total: number; pages: number }
type ReportStudent = { id: number; full_name: string; document_id: string; section_name: string }
type StudentSearchItem = { id: number; first_name: string; last_name: string; document_id: string; section_name: string }
type StudentSearchPage = { items: StudentSearchItem[] }

const severityNames: Record<string, string> = { leve: 'Leve', grave: 'Grave', muy_grave: 'Muy grave' }

function formatDate(value: string) {
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function localInputDate(value: string) {
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function reportStudents(report: Report): ReportStudent[] {
  if (report.students?.length) return report.students
  const names = report.student_names.split(', ')
  const documents = report.student_documents.split(', ')
  return report.student_ids.map((id, index) => ({
    id,
    full_name: names[index] || `Estudiante #${id}`,
    document_id: documents[index] || 'Documento no disponible',
    section_name: '',
  }))
}

function ReportEditor({ report, token, onClose, onSaved }: { report: Report; token: string; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [students, setStudents] = useState(() => reportStudents(report))
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ReportStudent[]>([])
  const [searchError, setSearchError] = useState('')
  const [searching, setSearching] = useState(false)
  const selectedIds = new Set(students.map((student) => student.id))

  useEffect(() => {
    const term = query.trim()
    setResults([])
    setSearchError('')
    if (term.length < 2) {
      setSearching(false)
      return
    }
    let current = true
    setSearching(true)
    const timer = window.setTimeout(() => {
      fetch(`/api/students?q=${encodeURIComponent(term)}&page=1&page_size=8`, { headers: { Authorization: `Bearer ${token}` } })
        .then(async (response) => {
          const result = await response.json()
          if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'No se pudieron buscar estudiantes.')
          return result as StudentSearchPage
        })
        .then((result) => {
          if (!current) return
          setResults(result.items.map((student) => ({ id: student.id, full_name: `${student.first_name} ${student.last_name}`, document_id: student.document_id, section_name: student.section_name })))
          setSearching(false)
        })
        .catch((reason: Error) => {
          if (current) {
            setSearchError(reason.message)
            setSearching(false)
          }
        })
    }, 180)
    return () => { current = false; window.clearTimeout(timer) }
  }, [query, token])

  function addStudent(student: ReportStudent) {
    setStudents((current) => current.some((item) => item.id === student.id) ? current : [...current, student])
    setQuery('')
    setResults([])
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/reports/${report.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          severity: form.get('severity'),
          description: form.get('description'),
          action_taken: form.get('action_taken') || null,
          subject: form.get('subject') || null,
          location: form.get('location') || null,
          occurred_at: new Date(String(form.get('occurred_at'))).toISOString(),
          student_ids: students.map((student) => student.id),
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'No se pudo guardar el reporte.')
      onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo guardar el reporte.')
    } finally {
      setBusy(false)
    }
  }

  return <div className="admin-modal-backdrop" role="presentation" onClick={onClose}>
    <section className="admin-editor-modal" role="dialog" aria-modal="true" aria-labelledby="history-report-edit-title" onClick={(event) => event.stopPropagation()}>
      <div className="admin-editor-heading"><div><p className="eyebrow">HISTORIAL GENERAL</p><h2 id="history-report-edit-title">Editar reporte</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Cerrar edición"><X size={19} /></button></div>
      <form className="admin-form-panel" onSubmit={submit}>
        <label className="field-label">Gravedad<select name="severity" defaultValue={report.severity}><option value="leve">Leve</option><option value="grave">Grave</option><option value="muy_grave">Muy grave</option></select></label>
        <label className="field-label">Descripción<textarea name="description" required minLength={5} defaultValue={report.description} rows={4} /></label>
        <label className="field-label">Acciones tomadas<textarea name="action_taken" defaultValue={report.action_taken ?? ''} rows={3} /></label>
        <div className="admin-name-grid"><label className="field-label">Materia<input name="subject" defaultValue={report.subject ?? ''} /></label><label className="field-label">Lugar<input name="location" defaultValue={report.location ?? ''} /></label></div>
        <label className="field-label">Fecha y hora del incidente<input name="occurred_at" type="datetime-local" required defaultValue={localInputDate(report.occurred_at)} /></label>
        <section className="report-student-editor" aria-label="Estudiantes involucrados">
          <h3>Estudiantes involucrados</h3>
          <label className="field-label">Buscar estudiante por nombre o documento<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Escribe al menos 2 caracteres…" autoComplete="off" /></label>
          {searchError && <p className="form-message" role="alert">{searchError}</p>}
          {searching && <p className="admin-inline-note" role="status">Buscando estudiantes…</p>}
          {results.length > 0 && <div className="report-student-results">{results.map((student) => <button type="button" key={student.id} disabled={selectedIds.has(student.id)} onClick={() => addStudent(student)}><span><strong>{student.full_name}</strong><small>C.I. {student.document_id} · {student.section_name}</small></span><span>{selectedIds.has(student.id) ? 'Incluido' : 'Incluir'}</span></button>)}</div>}
          {query.trim().length >= 2 && !searching && !searchError && results.length === 0 && <p className="admin-inline-note">No se encontraron estudiantes.</p>}
          <h4>Vinculados al reporte</h4>
          {students.length > 0 ? <div className="report-student-selected">{students.map((student) => <label className="report-student-row" key={student.id}><span><strong>{student.full_name}</strong><small>C.I. {student.document_id} · {student.section_name}</small></span><span><input type="checkbox" checked disabled={students.length === 1} aria-label={`Desvincular a ${student.full_name}`} onChange={() => setStudents((current) => current.filter((item) => item.id !== student.id))} />Desvincular</span></label>)}</div> : <p className="admin-inline-note">Añade al menos un estudiante al reporte.</p>}
          {students.length === 1 && <p className="admin-inline-note">El reporte debe conservar al menos un estudiante vinculado.</p>}
        </section>
        {students.map((student) => <input key={student.id} type="hidden" name="student_ids" value={student.id} />)}
        {error && <p className="form-message" role="alert">{error}</p>}
        <div className="admin-editor-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button><button className="submit-button" disabled={busy}>{busy ? 'Guardando…' : 'Guardar cambios'}</button></div>
      </form>
    </section>
  </div>
}

export default function ReportsHistoryView({ token, role }: { token: string; role: string }) {
  const [reports, setReports] = useState<Page>({ items: [], page: 1, page_size: 20, total: 0, pages: 0 })
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [includeInactive, setIncludeInactive] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)
  const [editing, setEditing] = useState<Report | null>(null)
  const [actionError, setActionError] = useState('')
  const [busyReportId, setBusyReportId] = useState<number | null>(null)
  const canIncludeInactive = role === 'admin' || role === 'coordinator'

  useEffect(() => {
    let current = true
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ page: String(page), page_size: '20' })
      if (search.trim()) query.set('q', search.trim())
      if (includeInactive && canIncludeInactive) query.set('include_inactive', 'true')
      setLoading(true)
      setError('')
      fetch(`/api/reports?${query}`, { headers: { Authorization: `Bearer ${token}` } })
        .then(async (response) => {
          const result = await response.json()
          if (!response.ok) {
            const detail = typeof result.detail === 'string' ? result.detail : 'No se pudo cargar el historial de reportes.'
            throw new Error(detail)
          }
          return result as Page
        })
        .then((result) => { if (current) setReports(result) })
        .catch((reason: Error) => { if (current) setError(reason.message) })
        .finally(() => { if (current) setLoading(false) })
    }, 160)
    return () => { current = false; window.clearTimeout(timer) }
  }, [canIncludeInactive, includeInactive, page, refreshKey, search, token])

  async function deactivateReport(report: Report) {
    if (!window.confirm('¿Desactivar este reporte? Se conservará en el historial administrativo.')) return
    setBusyReportId(report.id)
    setActionError('')
    try {
      const response = await fetch(`/api/reports/${report.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      if (!response.ok) {
        const result = await response.json()
        throw new Error(typeof result.detail === 'string' ? result.detail : 'No se pudo desactivar el reporte.')
      }
      setRefreshKey((current) => current + 1)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'No se pudo desactivar el reporte.')
    } finally {
      setBusyReportId(null)
    }
  }

  return <section className="report-history" aria-label="Historial general de reportes">
    <label className="report-history-search"><Search size={18} /><span className="sr-only">Buscar reportes</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder="Buscar por estudiante, documento, materia o descripción" /></label>
    {canIncludeInactive && <label className="inactive-toggle"><input type="checkbox" checked={includeInactive} onChange={(event) => { setIncludeInactive(event.target.checked); setPage(1) }} />Incluir reportes desactivados</label>}
    {error && <p className="form-message" role="alert">{error}</p>}
    {actionError && <p className="form-message" role="alert">{actionError}</p>}
    <div className="report-history-table-wrap">
      <table className="report-history-table">
        <thead><tr><th>Generado</th><th>Estudiante(s)</th><th>Materia / lugar</th><th>Reporte</th><th>Gravedad</th><th>Estado</th><th>Acciones</th></tr></thead>
        <tbody>{reports.items.map((report) => <tr key={report.id}>
          <td data-label="Generado">{formatDate(report.created_at)}</td>
          <td data-label="Estudiante(s)"><strong>{report.student_names || 'Sin estudiantes asociados'}</strong>{report.student_documents && <small>C.I. {report.student_documents}</small>}</td>
          <td data-label="Materia / lugar">{report.subject || 'Sin materia'}<small>{report.location || 'Lugar no indicado'}</small></td>
          <td data-label="Reporte"><p>{report.description}</p><small>Incidente: {formatDate(report.occurred_at)}</small></td>
          <td data-label="Gravedad"><span className={`report-severity severity-${report.severity}`}>{severityNames[report.severity] ?? report.severity}</span></td>
          <td data-label="Estado"><span className={`report-active-tag ${report.active ? 'active' : ''}`}>{report.active ? 'Activo' : 'Desactivado'}</span></td>
          <td data-label="Acciones"><div className="report-history-actions"><button type="button" disabled={!report.active || busyReportId === report.id} onClick={() => { setActionError(''); setEditing(report) }} aria-label={`Editar reporte de ${report.student_names || 'estudiante sin nombre'}`}><Pencil size={15} />Editar</button><button type="button" className="danger" disabled={!report.active || busyReportId === report.id} onClick={() => void deactivateReport(report)} aria-label={`Desactivar reporte de ${report.student_names || 'estudiante sin nombre'}`}><Trash2 size={15} />{busyReportId === report.id ? 'Desactivando…' : 'Desactivar'}</button></div></td>
        </tr>)}</tbody>
      </table>
      {!loading && !error && reports.items.length === 0 && <div className="empty-state report-history-empty"><strong>{search ? 'No se encontraron reportes' : 'Aún no hay reportes registrados'}</strong><span>{search ? 'Prueba otra búsqueda.' : 'Los reportes creados aparecerán aquí.'}</span></div>}
      {loading && <p className="report-history-loading" role="status">Cargando reportes…</p>}
    </div>
    <div className="report-history-pagination"><span>{reports.total} reportes · página {Math.max(reports.page, 1)} de {Math.max(reports.pages, 1)}</span><div><button type="button" className="icon-button" aria-label="Página anterior" disabled={page <= 1 || loading} onClick={() => setPage((current) => current - 1)}><ChevronLeft size={18} /></button><button type="button" className="icon-button" aria-label="Página siguiente" disabled={page >= reports.pages || loading} onClick={() => setPage((current) => current + 1)}><ChevronRight size={18} /></button></div></div>
    {editing && <ReportEditor report={editing} token={token} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setRefreshKey((current) => current + 1) }} />}
  </section>
}
