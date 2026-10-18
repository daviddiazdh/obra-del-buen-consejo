import { useState } from 'react'
import type { FormEvent } from 'react'
import { Pencil, Trash2, X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'

type ReportItem = { id: number; severity: string; description: string; action_taken: string | null; occurred_at: string; created_at: string; location: string | null; subject: string | null; student_ids: number[] }
type Profile = { student: { id: number; first_name: string; last_name: string; document_id: string; qr_token: string; section: string }; severity_counts: Record<string, number>; reports: ReportItem[]; guardians: { full_name: string; document_id: string; phone: string | null; email: string | null }[] }

function localInputDate(value: string) {
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function ReportEditor({ report, token, onClose, onSaved }: { report: ReportItem; token: string; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

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
          student_ids: report.student_ids,
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'No se pudo guardar el reporte.')
      onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo guardar el reporte.')
    } finally { setBusy(false) }
  }

  return <div className="admin-modal-backdrop" role="presentation" onClick={onClose}><section className="admin-editor-modal" role="dialog" aria-modal="true" aria-labelledby="report-edit-title" onClick={(event) => event.stopPropagation()}><div className="admin-editor-heading"><div><p className="eyebrow">EXPEDIENTE</p><h2 id="report-edit-title">Editar reporte</h2></div><button className="icon-button" onClick={onClose} aria-label="Cerrar"><X size={19} /></button></div><form className="admin-form-panel" onSubmit={submit}><label className="field-label">Gravedad<select name="severity" defaultValue={report.severity}><option value="leve">Leve</option><option value="grave">Grave</option><option value="muy_grave">Muy grave</option></select></label><label className="field-label">Descripción<textarea name="description" required minLength={5} defaultValue={report.description} rows={4} /></label><label className="field-label">Acciones tomadas<textarea name="action_taken" defaultValue={report.action_taken ?? ''} rows={3} /></label><div className="admin-name-grid"><label className="field-label">Materia<input name="subject" defaultValue={report.subject ?? ''} /></label><label className="field-label">Lugar<input name="location" defaultValue={report.location ?? ''} /></label></div><label className="field-label">Fecha y hora<input name="occurred_at" type="datetime-local" required defaultValue={localInputDate(report.occurred_at)} /></label>{error && <p className="form-message" role="alert">{error}</p>}<div className="admin-editor-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button><button className="submit-button" disabled={busy}>{busy ? 'Guardando…' : 'Guardar cambios'}</button></div></form></section></div>
}

export default function StudentProfileView({ profile, token, onBack, onChanged }: { profile: Profile; token: string; onBack: () => void; onChanged: () => void }) {
  const [editing, setEditing] = useState<ReportItem | null>(null)
  const [message, setMessage] = useState('')

  async function deactivateReport(report: ReportItem) {
    if (!window.confirm('¿Desactivar este reporte? Se conservará en el historial administrativo.')) return
    const response = await fetch(`/api/reports/${report.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    if (response.ok) { setMessage('Reporte desactivado.'); onChanged() }
    else setMessage('No se pudo desactivar el reporte.')
  }

  return <section className="content-wrap"><div className="page-heading"><div><p className="eyebrow">EXPEDIENTE · RESUMEN 360°</p><h1>{profile.student.first_name} {profile.student.last_name}</h1><p className="page-subtitle">{profile.student.section} · C.I. {profile.student.document_id}</p></div><button className="secondary-button" onClick={onBack}>← Directorio</button></div><div className="student-profile-grid"><article className="profile-card qr-card"><QRCodeSVG value={profile.student.qr_token} size={138} level="M" includeMargin /><strong>Código de identificación</strong><small>Token QR privado del sistema</small></article><div className="portal-metrics">{(['leve', 'grave', 'muy_grave'] as const).map((level, index) => <div className={`portal-metric metric-severity-${index}`} key={level}><span>{['Leves', 'Graves', 'Muy graves'][index]}</span><strong>{profile.severity_counts[level] ?? 0}</strong></div>)}</div><article className="list-panel profile-guardians"><div className="panel-heading"><div><h2>Representantes</h2><p>Contactos vinculados</p></div></div>{profile.guardians.map((guardian) => <div className="guardian-contact" key={guardian.document_id}><strong>{guardian.full_name}</strong><small>C.I. {guardian.document_id} · {guardian.phone || 'Sin teléfono'}</small><small>{guardian.email || 'Sin correo registrado'}</small></div>)}</article><article className="list-panel profile-history"><div className="panel-heading"><div><h2>Historial de convivencia</h2><p>Reportes activos · {profile.reports.length}</p></div></div>{message && <p className="import-message" role="status">{message}</p>}{profile.reports.length ? profile.reports.map((report) => <div className="profile-event" key={report.id}><span className={`event-level event-${report.severity}`} /><div><strong>{report.severity.replace('_', ' ')} · {report.subject || report.location || 'Incidente registrado'}</strong><p>{report.description}</p>{report.action_taken && <small>Acción: {report.action_taken}</small>}<small>Ocurrido: {new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(report.occurred_at))}</small><small className="profile-report-generated">Generado: {new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(report.created_at))}</small><div className="profile-report-actions"><button type="button" onClick={() => setEditing(report)}><Pencil size={14} />Editar</button><button type="button" onClick={() => void deactivateReport(report)}><Trash2 size={14} />Desactivar</button></div></div></div>) : <p className="portal-empty">Sin reportes activos.</p>}</article></div>{editing && <ReportEditor report={editing} token={token} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setMessage('Cambios guardados.'); onChanged() }} />}</section>
}
