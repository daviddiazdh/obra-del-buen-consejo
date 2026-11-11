import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, LoaderCircle, RotateCcw, X } from 'lucide-react'

type VersionInfo = {
  current: string
  latest: string | null
  update_available: boolean
  published_at: string | null
  release_notes: string | null
  release_url: string | null
  checked_at: string | null
  check_error: string | null
}
type UpdateStatus = { running: boolean; log: string; success: boolean | null; target_version: string | null; finished_at: string | null }

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : data.detail?.message || 'No se pudo completar la operación.')
  return data as T
}

function formatDate(value: string | null) {
  if (!value) return 'Nunca'
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export default function UpdatesPanel({ token }: { token: string }) {
  const [info, setInfo] = useState<VersionInfo | null>(null)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const pollRef = useRef<number | null>(null)
  const targetRef = useRef<string | null>(null)
  const settleRef = useRef<number | null>(null)

  function loadVersion() {
    setChecking(true)
    request<VersionInfo>('/api/system/version', token)
      .then((data) => { setInfo(data); setError('') })
      .catch((err: Error) => setError(err.message))
      .finally(() => setChecking(false))
  }

  useEffect(() => { loadVersion() }, [token])

  useEffect(() => () => {
    if (pollRef.current) window.clearInterval(pollRef.current)
    if (settleRef.current) window.clearInterval(settleRef.current)
  }, [])

  function pollStatus() {
    request<UpdateStatus>('/api/system/update/status', token)
      .then((data) => {
        setStatus(data)
        if (!data.running) {
          if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null }
          if (data.success) waitForRestart()
        }
      })
      .catch(() => { /* la API puede estar reiniciándose; se reintenta en el próximo tick */ })
  }

  function waitForRestart() {
    const startedAt = Date.now()
    settleRef.current = window.setInterval(() => {
      if (Date.now() - startedAt > 2 * 60_000) {
        if (settleRef.current) window.clearInterval(settleRef.current)
        return
      }
      request<VersionInfo>('/api/system/version', token)
        .then((data) => {
          setInfo(data)
          if (targetRef.current && data.current === targetRef.current && settleRef.current) {
            window.clearInterval(settleRef.current)
            settleRef.current = null
          }
        })
        .catch(() => { /* todavía reiniciando */ })
    }, 4000)
  }

  async function startUpdate() {
    if (!info?.latest) return
    setStarting(true)
    setError('')
    targetRef.current = info.latest
    try {
      await request('/api/system/update', token, { method: 'POST' })
      setStatus({ running: true, log: '', success: null, target_version: info.latest, finished_at: null })
      pollRef.current = window.setInterval(pollStatus, 3000)
      pollStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo iniciar la actualización.')
    } finally {
      setStarting(false)
    }
  }

  const updated = status && !status.running && status.success && info?.current === targetRef.current

  return <>
    <div className="admin-list-heading">
      <div><h2>Actualizaciones</h2><p>Revisa e instala nuevas versiones publicadas del sistema.</p></div>
      <button className="secondary-button" type="button" onClick={loadVersion} disabled={checking}>{checking ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}Verificar ahora</button>
    </div>

    {error && <p className="form-message" role="alert"><AlertTriangle size={15} />{error}</p>}
    {info?.check_error && <p className="form-message" role="alert"><AlertTriangle size={15} />{info.check_error}</p>}

    {info && <div className="admin-grid">
      <article className="admin-form-panel">
        <div className="section-title"><div><h2>Versión instalada</h2><p>Lo que está corriendo ahora en este servidor.</p></div></div>
        <p className="summary-line"><span>Versión actual</span><strong>{info.current}</strong></p>
        <p className="summary-line"><span>Última revisión a GitHub</span><strong>{formatDate(info.checked_at)}</strong></p>
      </article>

      <article className="admin-form-panel">
        <div className="section-title"><div><h2>Última versión publicada</h2><p>{info.latest ? `Publicada el ${formatDate(info.published_at)}` : 'Sin información todavía.'}</p></div></div>
        {info.update_available ? <p className="admin-message success" role="status"><Check size={16} />Hay una versión nueva disponible: <strong>{info.latest}</strong></p> : <p className="admin-inline-note">Ya tienes la última versión instalada.</p>}
        {info.release_notes && <pre className="admin-inline-note" style={{ whiteSpace: 'pre-wrap' }}>{info.release_notes}</pre>}
        {info.release_url && <a className="text-button" href={info.release_url} target="_blank" rel="noreferrer">Ver notas completas en GitHub →</a>}
        <button className="submit-button" type="button" onClick={startUpdate} disabled={!info.update_available || starting || Boolean(status?.running)}>
          {starting || status?.running ? <LoaderCircle className="spin" size={17} /> : null}
          {status?.running ? 'Actualizando…' : starting ? 'Iniciando…' : `Actualizar a ${info.latest ?? ''}`}
        </button>
        <p className="admin-inline-note">La aplicación quedará brevemente fuera de servicio mientras se reinician los contenedores.</p>
      </article>
    </div>}

    {status && <article className="admin-form-panel">
      <div className="section-title"><div><h2>Progreso del despliegue</h2><p>{status.running ? 'En curso…' : status.success ? 'Completado' : status.success === false ? 'Falló' : 'Sin actividad'}</p></div></div>
      {updated ? <p className="admin-message success" role="status"><Check size={16} />Actualizado a {info?.current}. <button className="text-button" type="button" onClick={() => window.location.reload()}>Recargar página</button></p>
        : status.success === false ? <p className="form-message" role="alert"><X size={15} />La actualización no se completó. Revisa el registro debajo.</p>
        : status.running ? <p className="admin-inline-note"><LoaderCircle className="spin" size={14} />Descargando y reiniciando los servicios…</p> : null}
      {status.log && <pre className="admin-inline-note" style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto', fontFamily: 'monospace', fontSize: '0.8em' }}>{status.log}</pre>}
    </article>}
  </>
}
