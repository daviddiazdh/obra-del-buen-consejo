import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import AdminPanel from './AdminPanel'
import CitationsView from './CitationsView'
import ReportsHistoryView from './ReportsHistoryView'
import StudentProfileView from './StudentProfileView'
import {
  AlertTriangle, Bell, BookOpen, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight,
  ClipboardList, Clock3, DoorOpen, FileUp, GraduationCap, LayoutDashboard,
  LoaderCircle, LogOut, Menu, Plus, QrCode, Search, Send, ShieldCheck,
  SlidersHorizontal, Users, UserPlus, X,
} from 'lucide-react'

type Student = { id: number; first_name: string; last_name: string; document_id: string; section_name: string; section_id: number; qr_token: string }
type ApiPage<T> = { items: T[]; page: number; page_size: number; total: number; pages: number }
type GuardianSummary = { guardian: { full_name: string; telegram_linked: boolean; telegram_url: string | null; telegram_error: string | null }; students: { id: number; first_name: string; last_name: string; section: string }[]; reports: { student_name: string; severity: string; description: string; action_taken: string | null; occurred_at: string }[]; citations: { id: number; scheduled_at: string; reason: string; status: string; guardian_confirmed: boolean }[]; messages: { id: number; body: string; status: string; created_at: string }[] }
type StudentProfile = { student: { id: number; first_name: string; last_name: string; document_id: string; qr_token: string; section: string }; severity_counts: Record<string, number>; reports: { id: number; severity: string; description: string; action_taken: string | null; occurred_at: string; created_at: string; location: string | null; subject: string | null; student_ids: number[] }[]; guardians: { full_name: string; document_id: string; phone: string | null; email: string | null }[]; citations: { id: number; scheduled_at: string; reason: string; status: string }[] }
type View = 'Inicio' | 'Reportes' | 'Citaciones' | 'Estudiantes' | 'Administración' | 'Importar datos' | 'Portal'

const navItems: { label: View; icon: typeof LayoutDashboard }[] = [
  { label: 'Inicio', icon: LayoutDashboard },
  { label: 'Reportes', icon: ClipboardList },
  { label: 'Citaciones', icon: CalendarDays },
  { label: 'Estudiantes', icon: Users },
  { label: 'Administración', icon: UserPlus },
  { label: 'Importar datos', icon: FileUp },
  { label: 'Portal', icon: ShieldCheck },
]
const levels = ['Leve', 'Grave', 'Muy grave'] as const
const levelStyles = ['level-mild', 'level-serious', 'level-critical']

function apiErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== 'object' || !('detail' in payload)) return fallback
  const detail = payload.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => {
      if (!item || typeof item !== 'object' || !('msg' in item)) return ''
      const rawField = 'loc' in item && Array.isArray(item.loc) ? item.loc.slice(-1)[0] : ''
      const field = rawField === 'description' ? 'Descripción' : rawField === 'action_taken' ? 'Acciones tomadas' : String(rawField)
      const rawMessage = String(item.msg).replace(/^Value error,\s*/i, '')
      const lengthError = rawMessage.match(/^string should have at least (\d+) characters?$/i)
      const message = lengthError ? `debe tener al menos ${lengthError[1]} caracteres` : rawMessage
      return `${field ? `${field}: ` : ''}${message}`
    }).filter(Boolean)
    if (messages.length) return messages.join(' · ')
  }
  return fallback
}

function App() {
  const [view, setView] = useState<View>('Reportes')
  const [reportMode, setReportMode] = useState<'new' | 'history'>('new')
  const [students, setStudents] = useState<Student[]>([])
  const [token, setToken] = useState(() => localStorage.getItem('obc-token') ?? '')
  const [role, setRole] = useState(() => localStorage.getItem('obc-role') ?? '')
  const [rosterVersion, setRosterVersion] = useState(0)
  const [matches, setMatches] = useState<Student[]>([])
  const [loginError, setLoginError] = useState('')
  const [loginBusy, setLoginBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Student[]>([])
  const [severity, setSeverity] = useState<(typeof levels)[number]>('Leve')
  const [incident, setIncident] = useState('')
  const [actionTaken, setActionTaken] = useState('')
  const [place, setPlace] = useState('')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const controlsRef = useRef<{ stop: () => void } | null>(null)
  const qrBusyRef = useRef(false)

  useEffect(() => {
    if (!token || role === 'guardian') {
      setStudents([])
      return
    }
    fetch('/api/students?page=1&page_size=100', { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => {
        if (response.status === 401) {
          localStorage.removeItem('obc-token')
          setToken('')
          throw new Error('Sesión vencida')
        }
        return response.ok ? response.json() : []
      })
      .then((data: ApiPage<Student>) => setStudents(data.items))
      .catch(() => setStudents([]))
  }, [token, role, rosterVersion])

  useEffect(() => {
    const term = query.trim()
    if (!token || term.length < 2) {
      setMatches([])
      return
    }
    const timer = window.setTimeout(() => {
      fetch(`/api/students?q=${encodeURIComponent(term)}&page=1&page_size=6`, { headers: { Authorization: `Bearer ${token}` } })
        .then((response) => response.ok ? response.json() : { items: [] })
        .then((data: ApiPage<Student>) => setMatches(data.items))
        .catch(() => setMatches([]))
    }, 180)
    return () => window.clearTimeout(timer)
  }, [query, token])

  useEffect(() => {
    if (!scannerOpen || !videoRef.current) return
    let active = true
    const videoElement = videoRef.current
    setCameraError('')
    import('@zxing/browser').then(({ BrowserQRCodeReader }) => {
      if (!active) return
      const reader = new BrowserQRCodeReader()
      return reader.decodeFromConstraints(
        { audio: false, video: { facingMode: { ideal: 'environment' } } },
        videoElement,
        (result) => {
          if (!active || !result) return
          if (qrBusyRef.current) return
          qrBusyRef.current = true
          fetch(`/api/students/qr/${encodeURIComponent(result.getText())}`, { headers: { Authorization: `Bearer ${token}` } })
            .then(async (response) => {
              const student = await response.json()
              if (!response.ok) throw new Error(student.detail || 'Código QR no reconocido.')
              addStudent(student)
              setScannerOpen(false)
            })
            .catch((error: Error) => setCameraError(error.message))
            .finally(() => { qrBusyRef.current = false })
        },
      ).then((controls) => {
        controlsRef.current = controls
        if (!active) controls.stop()
      })
    }).catch(() => setCameraError('Permite el acceso a la cámara y verifica que estés usando HTTPS.'))
    return () => {
      active = false
      controlsRef.current?.stop()
      controlsRef.current = null
    }
  }, [scannerOpen, students])

  function addStudent(student: Student) {
    setSelected((current) => current.some((item) => item.id === student.id) ? current : [...current, student])
    setQuery('')
    setMessage('')
  }

  async function submitReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (selected.length === 0) return setMessage('Selecciona al menos un estudiante.')
    setSaving(true)
    setMessage('')
    try {
      const response = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          severity: severity.toLowerCase().replace(' ', '_'),
          description: incident,
          action_taken: actionTaken,
          subject,
          location: place,
          occurred_at: new Date().toISOString(),
          student_ids: selected.map((student) => student.id),
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(apiErrorMessage(result, 'No se pudo guardar el reporte. Revisa la conexión o los datos.'))
      setMessage('Reporte registrado. La notificación al representante quedó encolada.')
      setSelected([])
      setIncident('')
      setActionTaken('')
      setPlace('')
      setSubject('')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudo conectar con el servidor.')
    } finally {
      setSaving(false)
    }
  }

  const dateLabel = new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())
  const greeting = view === 'Reportes' ? reportMode === 'new' ? 'Registro de incidencia' : 'Historial de reportes' : view
  const visibleNav = role === 'guardian' ? navItems.filter((item) => item.label === 'Portal') : role === 'doorman' ? navItems.filter((item) => item.label === 'Citaciones') : role === 'teacher' ? navItems.filter((item) => ['Reportes', 'Estudiantes'].includes(item.label)) : role === 'coordinator' ? navItems.filter((item) => ['Inicio', 'Reportes', 'Citaciones', 'Estudiantes'].includes(item.label)) : navItems.filter((item) => item.label !== 'Portal')

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoginBusy(true)
    setLoginError('')
    const form = new FormData(event.currentTarget)
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: form.get('username'), password: form.get('password') }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'No se pudo iniciar sesión.')
      localStorage.setItem('obc-token', data.access_token)
      localStorage.setItem('obc-role', data.role)
      setToken(data.access_token)
      setRole(data.role)
      setView(data.role === 'guardian' ? 'Portal' : data.role === 'doorman' ? 'Citaciones' : 'Reportes')
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'No se pudo conectar con el servidor.')
    } finally {
      setLoginBusy(false)
    }
  }

  function signOut() {
    localStorage.removeItem('obc-token')
    localStorage.removeItem('obc-role')
    setToken('')
    setRole('')
  }

  if (!token) return <main className="login-screen"><div className="login-panel"><a className="brand login-brand" href="#acceso"><span className="brand-mark"><ShieldCheck size={23} /></span><span><strong>Buen Consejo</strong><small>CONVIVENCIA ESCOLAR</small></span></a><p className="eyebrow">SISTEMA ESCOLAR · BACHILLERATO</p><h1>Bienvenido de vuelta</h1><p className="page-subtitle">Ingresa con tu cuenta institucional para continuar.</p><form onSubmit={signIn}><label className="field-label">Usuario<input name="username" autoComplete="username" required placeholder="Tu usuario institucional" /></label><label className="field-label">Contraseña<input name="password" type="password" autoComplete="current-password" required placeholder="Tu contraseña" /></label>{loginError && <p className="form-message" role="alert">{loginError}</p>}<button className="submit-button" disabled={loginBusy}>{loginBusy ? 'Ingresando…' : 'Ingresar'}</button></form><p className="privacy-note"><ShieldCheck size={14} />Acceso privado para la comunidad educativa</p></div><div className="login-side"><span className="login-seal"><ShieldCheck size={36} /></span><p>OBRA DEL BUEN CONSEJO</p><strong>Una comunidad que acompaña.</strong><span>Registro · seguimiento · convivencia</span></div></main>

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#inicio" onClick={() => setView('Inicio')}>
          <span className="brand-mark"><ShieldCheck size={23} strokeWidth={1.8} /></span>
          <span><strong>Buen Consejo</strong><small>CONVIVENCIA ESCOLAR</small></span>
        </a>
        <div className="school-switch"><span className="school-dot" />Bachillerato<ChevronDown size={15} /></div>
        <p className="nav-caption">GESTIÓN</p>
        <nav className="side-nav" aria-label="Navegación principal">
          {visibleNav.map(({ label, icon: Icon }) => (
            <button key={label} className={`nav-item ${view === label ? 'active' : ''}`} onClick={() => setView(label)}>
              <Icon size={19} strokeWidth={1.8} /><span>{label}</span>
              {label === 'Citaciones' && <span className="nav-count">4</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="profile-row"><div className="avatar">BC</div><div><strong>Cuenta institucional</strong><small>Sesión activa</small></div><button aria-label="Cerrar sesión" onClick={signOut}><LogOut size={17} /></button></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu icon-button" aria-label="Abrir menú"><Menu size={21} /></button>
          <div className="breadcrumbs">Bachillerato <span>/</span> <strong>{greeting}</strong></div>
          <div className="top-actions"><span className="date-chip"><CalendarDays size={16} />{dateLabel}</span><button className="icon-button notification-button" aria-label="Notificaciones"><Bell size={19} /><i /></button></div>
        </header>

        {view === 'Reportes' ? (
          <section className="content-wrap report-page">
            <div className="page-heading"><div><p className="eyebrow">AULA · REGISTRO RÁPIDO</p><h1>{reportMode === 'new' ? 'Nuevo reporte' : 'Historial general de reportes'}</h1><p className="page-subtitle">{reportMode === 'new' ? 'Documenta una situación para dar seguimiento oportuno.' : 'Consulta los reportes del sistema sin abrir cada expediente.'}</p></div><div className="report-page-actions"><button className="secondary-button" onClick={() => setReportMode((mode) => mode === 'new' ? 'history' : 'new')}>{reportMode === 'new' ? 'Historial general' : 'Crear reporte'}</button><button className="secondary-button" onClick={() => setView('Citaciones')}><CalendarDays size={17} />Ver agenda</button></div></div>
            {reportMode === 'history' ? <ReportsHistoryView token={token} role={role} /> : <form className="report-layout" onSubmit={submitReport}>
              <div className="form-column">
                <section className="form-section student-section">
                  <div className="section-title"><span className="step-number">1</span><div><h2>Estudiantes involucrados</h2><p>Busca por nombre, documento o sección. Puedes añadir varios.</p></div></div>
                  <div className="student-search-row">
                    <div className="search-wrap"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar estudiante o escanear código" autoComplete="off" /><kbd>⌘ K</kbd>
                      {matches.length > 0 && <div className="search-results">{matches.map((student) => <button type="button" key={student.id} onClick={() => addStudent(student)}><span className="student-avatar">{student.first_name[0]}{student.last_name[0]}</span><span><strong>{student.first_name} {student.last_name}</strong><small>{student.section_name} · C.I. {student.document_id}</small></span><Plus size={17} /></button>)}</div>}
                      {query && matches.length === 0 && <div className="search-empty">Sin coincidencias. Revisa la búsqueda o importa estudiantes.</div>}
                    </div>
                    <button className="scan-button" type="button" onClick={() => setScannerOpen(true)} aria-label="Escanear código QR"><QrCode size={20} /><span>Escanear</span></button>
                  </div>
                  {selected.length > 0 ? <div className="selected-list">{selected.map((student) => <span className="selected-chip" key={student.id}><span className="student-avatar small">{student.first_name[0]}{student.last_name[0]}</span>{student.first_name} {student.last_name}<button type="button" aria-label={`Quitar ${student.first_name}`} onClick={() => setSelected((current) => current.filter((item) => item.id !== student.id))}><X size={15} /></button></span>)}</div> : <div className="selection-hint"><Users size={18} /><span>{students.length === 0 ? 'Aún no hay estudiantes cargados.' : 'Los estudiantes seleccionados aparecerán aquí.'}</span>{students.length === 0 && <button type="button" onClick={() => setView('Importar datos')}>Importar lista <span>→</span></button>}</div>}
                </section>

                <section className="form-section">
                  <div className="section-title"><span className="step-number">2</span><div><h2>Clasificación del incidente</h2><p>Elige la categoría que mejor describe la situación.</p></div></div>
                  <div className="severity-options" role="radiogroup" aria-label="Gravedad">
                    {levels.map((level, index) => <button type="button" key={level} role="radio" aria-checked={severity === level} className={`severity-option ${severity === level ? 'selected' : ''} ${levelStyles[index]}`} onClick={() => setSeverity(level)}><span className="severity-dot" /><span><strong>{level}</strong><small>{['Situación menor, primera vez', 'Requiere seguimiento formal', 'Atención prioritaria'][index]}</small></span>{severity === level && <Check size={17} />}</button>)}
                  </div>
                  <label className="field-label" htmlFor="description">Descripción del incidente <span>Requerido</span></label>
                  <textarea id="description" value={incident} onChange={(event) => setIncident(event.target.value)} placeholder="Describe los hechos de forma clara y objetiva…" required rows={4} />
                  <div className="field-grid"><label className="field-label">Materia<input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Ej. Matemática" /></label><label className="field-label">Lugar<input value={place} onChange={(event) => setPlace(event.target.value)} placeholder="Ej. Aula 3B" /></label></div>
                  <label className="field-label action-field">Acciones tomadas<textarea value={actionTaken} onChange={(event) => setActionTaken(event.target.value)} placeholder="Mediación, conversación con el grupo, seguimiento acordado…" rows={2} /></label>
                </section>
              </div>

              <aside className="summary-column"><div className="summary-card"><div className="summary-header"><span className="summary-icon"><ClipboardList size={18} /></span><div><h2>Resumen</h2><p>Revisa antes de guardar</p></div></div><div className="summary-line"><span>Fecha y hora</span><strong><Clock3 size={15} />{new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date())}</strong></div><div className="summary-line"><span>Gravedad</span><strong className={`summary-severity severity-text-${levels.indexOf(severity)}`}>{severity}</strong></div><div className="summary-line"><span>Estudiantes</span><strong>{selected.length} seleccionado{selected.length === 1 ? '' : 's'}</strong></div><div className="notify-note"><Bell size={17} /><span>Se registrará un aviso Telegram cuando el representante haya vinculado su cuenta.</span></div>{message && <p className={`form-message ${message.startsWith('Reporte registrado') ? 'success' : ''}`} role={message.startsWith('Reporte registrado') ? 'status' : 'alert'}>{message}</p>}<button className="submit-button" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" size={18} /> : <Send size={17} />}{saving ? 'Guardando…' : 'Registrar reporte'}</button><p className="privacy-note"><ShieldCheck size={14} />Visible solo para personal autorizado</p></div><div className="quick-tip"><AlertTriangle size={18} /><p><strong>¿Necesitas citar?</strong><br />Podrás agendar al representante desde el expediente del reporte.</p></div></aside>
            </form>}
          </section>
        ) : view === 'Inicio' ? <DashboardView token={token} setView={setView} /> : view === 'Citaciones' ? <CitationsView token={token} role={role} /> : view === 'Administración' ? <AdminPanel token={token} onStudentsChanged={() => setRosterVersion((version) => version + 1)} /> : <OtherView view={view} setView={setView} token={token} onImported={() => setRosterVersion((version) => version + 1)} />}
      </main>

      <nav className="mobile-nav" aria-label="Navegación móvil">{visibleNav.map(({ label, icon: Icon }) => <button key={label} className={view === label ? 'active' : ''} onClick={() => setView(label)}><Icon size={19} /><span>{label === 'Estudiantes' ? 'Alumnos' : label === 'Administración' ? 'Admin' : label}</span></button>)}</nav>

      {scannerOpen && <div className="sheet-backdrop" role="presentation" onClick={() => setScannerOpen(false)}><section className="scanner-sheet" role="dialog" aria-modal="true" aria-labelledby="scanner-title" onClick={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="scanner-heading"><div><p className="eyebrow">LECTOR DE CÓDIGO</p><h2 id="scanner-title">Escanear estudiante</h2></div><button className="icon-button" onClick={() => setScannerOpen(false)} aria-label="Cerrar escáner"><X size={20} /></button></div><div className="camera-frame"><video ref={videoRef} muted playsInline />{!cameraError && <span className="scan-guide" />}</div>{cameraError ? <p className="camera-error" role="alert">{cameraError}</p> : <p className="camera-caption">Centra el código QR dentro del recuadro.</p>}<button className="secondary-button full-button" onClick={() => setScannerOpen(false)}>Cancelar</button></section></div>}
    </div>
  )
}

function OtherView({ view, setView, token, onImported }: { view: View; setView: (view: View) => void; token: string; onImported: () => void }) {
  const [citations, setCitations] = useState<{ id: number; guardian_name: string; guardian_document: string; student_names: string; student_documents: string; scheduled_at: string; reason: string; status: string }[]>([])
  const [portal, setPortal] = useState<GuardianSummary | null>(null)
  const [portalError, setPortalError] = useState('')
  const [importMessage, setImportMessage] = useState('')
  const [agendaSearch, setAgendaSearch] = useState('')

  useEffect(() => {
    if (view !== 'Citaciones') return
    fetch('/api/citations', { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.detail || 'No se pudo cargar la agenda.')
        setCitations(data)
      })
      .catch(() => setCitations([]))
  }, [view, token])

  useEffect(() => {
    if (view !== 'Portal') return
    fetch('/api/guardian/summary', { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.detail || 'No se pudo cargar el portal.')
        setPortal(data)
        setPortalError(data.guardian.telegram_error ?? '')
      })
      .catch((error: Error) => setPortalError(error.message))
  }, [view, token])

  async function uploadRoster(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    setImportMessage('Importando…')
    try {
      const response = await fetch('/api/import/students', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: data })
      const result = await response.json()
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : result.detail?.message || 'Revisa las columnas del archivo.')
      setImportMessage(`Importación completa: ${result.created_students} estudiantes; ${result.created_or_linked_guardians} representantes vinculados.`)
      onImported()
      form.reset()
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : 'No se pudo importar el archivo.')
    }
  }

  async function setCitationStatus(id: number, status: string) {
    const response = await fetch(`/api/citations/${id}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ status }) })
    if (response.ok) setCitations((current) => current.map((citation) => citation.id === id ? { ...citation, status } : citation))
  }

  async function confirmCitation(id: number) {
    const response = await fetch(`/api/guardian/citations/${id}/confirm`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } })
    if (response.ok) setPortal((current) => current ? { ...current, citations: current.citations.map((item) => item.id === id ? { ...item, guardian_confirmed: true } : item) } : current)
  }

  if (view === 'Portal') return <section className="content-wrap portal-view"><div className="page-heading"><div><p className="eyebrow">PORTAL FAMILIAR · BUEN CONSEJO</p><h1>{portal?.guardian.full_name ? `Hola, ${portal.guardian.full_name.split(' ')[0]}` : 'Mi familia'}</h1><p className="page-subtitle">Seguimiento escolar de tus representados.</p></div><div className="portal-link-area"><span className={`telegram-chip ${portal?.guardian.telegram_linked ? 'linked' : ''}`}><Send size={15} />{portal?.guardian.telegram_linked ? 'Telegram vinculado' : 'Telegram sin vincular'}</span>{portal?.guardian.telegram_url && <a className="telegram-link-button" href={portal.guardian.telegram_url} target="_blank" rel="noreferrer">Vincular Telegram</a>}</div></div>{portalError && <p className="form-message" role="alert">{portalError}</p>}{portal?.guardian.telegram_url && <p className="portal-link-hint">Abre el enlace para activar los avisos del colegio en Telegram.</p>}<div className="portal-students">{portal?.students.map((student) => <article className="portal-student" key={student.id}><span className="student-avatar"><GraduationCap size={17} /></span><span><strong>{student.first_name} {student.last_name}</strong><small>{student.section}</small></span><span className="portal-student-count">{portal.reports.filter((report) => report.student_name === `${student.first_name} ${student.last_name}`).length} novedades</span></article>)}</div><div className="portal-metrics">{(['leve', 'grave', 'muy_grave'] as const).map((level, index) => <div className={`portal-metric metric-severity-${index}`} key={level}><span>{['Leves', 'Graves', 'Muy graves'][index]}</span><strong>{portal?.reports.filter((report) => report.severity === level).length ?? 0}</strong></div>)}</div><div className="portal-columns"><section className="list-panel"><div className="panel-heading"><div><h2>Citaciones</h2><p>Agenda y confirmación de asistencia</p></div></div>{portal?.citations.length ? portal.citations.map((citation) => <article className="portal-citation" key={citation.id}><div><strong>{new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(citation.scheduled_at))}</strong><small>{citation.reason}</small></div>{citation.guardian_confirmed ? <span className="confirmed-tag"><Check size={14} />Confirmada</span> : <button className="secondary-button" onClick={() => confirmCitation(citation.id)}>Confirmar</button>}</article>) : <p className="portal-empty">No tienes citaciones pendientes.</p>}</section><section className="list-panel"><div className="panel-heading"><div><h2>Actividad reciente</h2><p>Mensajes y reportes de convivencia</p></div></div>{portal?.messages.map((message) => <article className="portal-message" key={message.id}><Bell size={16} /><span><strong>{message.body}</strong><small>{new Intl.DateTimeFormat('es', { dateStyle: 'medium' }).format(new Date(message.created_at))}</small></span></article>)}{portal?.reports.slice(0, 5).map((report, index) => <article className="portal-message" key={`${report.student_name}-${report.occurred_at}-${index}`}><ClipboardList size={16} /><span><strong>{report.student_name} · {report.severity.replace('_', ' ')}</strong><small>{new Intl.DateTimeFormat('es', { dateStyle: 'medium' }).format(new Date(report.occurred_at))} · {report.description}</small></span></article>)}{!portal?.messages.length && !portal?.reports.length && <p className="portal-empty">No hay novedades recientes.</p>}</section></div></section>

  if (view === 'Importar datos') return <section className="content-wrap"><div className="page-heading"><div><p className="eyebrow">DATOS ACADÉMICOS</p><h1>Importar estudiantes</h1><p className="page-subtitle">Carga una hoja CSV o Excel con estudiantes y representantes.</p></div></div><form className="import-panel" onSubmit={uploadRoster}><div className="upload-mark"><FileUp size={25} /></div><h2>Selecciona una plantilla</h2><p>Formatos aceptados: .xlsx y .csv</p><input aria-label="Archivo Excel o CSV" type="file" name="file" accept=".xlsx,.csv" required /><button className="submit-button" type="submit">Importar archivo</button>{importMessage && <p className="import-message" role="status">{importMessage}</p>}<small>Columnas requeridas: nombres, apellidos, documento, anio, seccion. Opcionales: representante, documento_representante, telefono, correo.</small></form></section>
  if (view === 'Estudiantes') return <DirectoryView token={token} setView={setView} />
  if (view === 'Citaciones') return <section className="content-wrap"><div className="page-heading"><div><p className="eyebrow">PORTERÍA · HOY</p><h1>Agenda de citaciones</h1><p className="page-subtitle">Control diario de representantes citados.</p></div><span className="date-chip"><CalendarDays size={16} />{new Intl.DateTimeFormat('es', { day: 'numeric', month: 'long' }).format(new Date())}</span></div><label className="agenda-search"><Search size={18} /><input value={agendaSearch} onChange={(event) => setAgendaSearch(event.target.value)} placeholder="Buscar representante, cédula o estudiante" /></label><div className="citation-list">{citations.filter((item) => `${item.guardian_name} ${item.guardian_document} ${item.student_names} ${item.student_documents}`.toLowerCase().includes(agendaSearch.toLowerCase())).map((item) => <article className="citation-card" key={item.id}><div className="citation-info"><span className="citation-time">{new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(new Date(item.scheduled_at))}</span><span><strong>{item.guardian_name}</strong><small>{item.student_names} · C.I. {item.guardian_document}</small><small>{item.reason}</small></span><span className={`citation-status status-${item.status}`}>{item.status === 'pending' ? 'Pendiente' : item.status === 'attended' ? 'Atendido' : 'No asistió'}</span></div>{item.status === 'pending' && <div className="citation-actions"><button onClick={() => setCitationStatus(item.id, 'attended')}><Check size={16} />Atendido</button><button onClick={() => setCitationStatus(item.id, 'no_show')}><X size={16} />No asistió</button></div>}</article>)}{citations.length === 0 && <div className="empty-state schedule-empty"><DoorOpen size={30} /><strong>Sin representantes citados hoy</strong><span>Las nuevas citaciones aparecerán en esta agenda.</span></div>}</div></section>
  return <section className="content-wrap"><div className="page-heading"><div><p className="eyebrow">RESUMEN ESCOLAR</p><h1>Buen día, María</h1><p className="page-subtitle">Seguimiento de convivencia · {new Intl.DateTimeFormat('es', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())}</p></div><button className="submit-button compact" onClick={() => setView('Reportes')}><Plus size={17} />Nuevo reporte</button></div><div className="metric-grid"><div className="metric-card"><span>Reportes del mes</span><strong>28</strong><small><span className="metric-up">+8%</span> frente al mes anterior</small><ClipboardList size={19} /></div><div className="metric-card"><span>Citaciones pendientes</span><strong>04</strong><small>2 programadas para hoy</small><CalendarDays size={19} /></div><div className="metric-card"><span>Seguimiento prioritario</span><strong>03</strong><small>Casos muy graves</small><AlertTriangle size={19} /></div></div><div className="dashboard-lower"><div className="list-panel"><div className="panel-heading"><div><h2>Actividad reciente</h2><p>Últimos reportes registrados</p></div><button className="text-button" onClick={() => setView('Reportes')}>Ver reportes →</button></div>{['Incidencias registradas', 'Seguimiento de convivencia', 'Citaciones de representantes'].map((item, index) => <div className="activity-row" key={item}><span className={`activity-mark mark-${index}`}><BookOpen size={16} /></span><span><strong>{item}</strong><small>{['Hoy · 10:24 a. m.', 'Ayer · 2:10 p. m.', 'Ayer · 9:35 a. m.'][index]}</small></span><span className={`activity-tag tag-${index}`}>{['Leve', 'Grave', 'Agenda'][index]}</span></div>)}</div><div className="list-panel focus-panel"><div className="panel-heading"><div><h2>Por nivel</h2><p>Reportes de este mes</p></div><button className="icon-button" aria-label="Filtrar"><SlidersHorizontal size={17} /></button></div>{['Leves', 'Graves', 'Muy graves'].map((label, index) => <div className="bar-row" key={label}><div><span>{label}</span><strong>{[16, 9, 3][index]}</strong></div><div className="bar-track"><i style={{ width: `${[72, 42, 16][index]}%` }} className={`bar-fill fill-${index}`} /></div></div>)}</div></div></section>
}

export function LegacyCitationView({ token, role }: { token: string; role: string }) {
  type CitationItem = { id: number; guardian_name: string; guardian_document: string; student_names: string; student_documents: string; scheduled_at: string; reason: string; status: string }
  const [citations, setCitations] = useState<CitationItem[]>([])
  const [guardians, setGuardians] = useState<{ id: number; full_name: string; document_id: string }[]>([])
  const [search, setSearch] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const canSchedule = role === 'admin' || role === 'coordinator'
  const localDateTime = new Date(Date.now() + 86_400_000)
  const scheduleDefault = new Date(localDateTime.getTime() - localDateTime.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)

  useEffect(() => {
    fetch('/api/citations', { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.detail || 'No se pudo cargar la agenda.')
        setCitations(data)
      })
      .catch((error: Error) => setMessage(error.message))
    if (canSchedule) {
      fetch('/api/guardians', { headers: { Authorization: `Bearer ${token}` } })
        .then((response) => response.ok ? response.json() : [])
        .then(setGuardians)
    }
  }, [canSchedule, token])

  async function submitCitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setBusy(true)
    setMessage('')
    try {
      const response = await fetch('/api/citations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ guardian_id: Number(form.get('guardian_id')), scheduled_at: new Date(String(form.get('scheduled_at'))).toISOString(), reason: form.get('reason') }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'No se pudo agendar la citación.')
      setMessage('Citación agendada; se registró el aviso al representante.')
      if (new Date(data.scheduled_at).toDateString() === new Date().toDateString()) setCitations((current) => [...current, data].sort((first, second) => first.scheduled_at.localeCompare(second.scheduled_at)))
      formElement.reset()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudo agendar la citación.')
    } finally {
      setBusy(false)
    }
  }

  async function updateStatus(id: number, status: string) {
    const response = await fetch(`/api/citations/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status }),
    })
    if (response.ok) setCitations((current) => current.map((item) => item.id === id ? { ...item, status } : item))
  }

  const filtered = citations.filter((item) => `${item.guardian_name} ${item.guardian_document} ${item.student_names} ${item.student_documents}`.toLowerCase().includes(search.toLowerCase()))
  return <section className="content-wrap"><div className="page-heading"><div><p className="eyebrow">PORTERÍA · AGENDA DIARIA</p><h1>Citaciones</h1><p className="page-subtitle">Control de asistencia y programación de representantes.</p></div><span className="date-chip"><CalendarDays size={16} />{new Intl.DateTimeFormat('es', { dateStyle: 'long' }).format(new Date())}</span></div>{canSchedule && <form className="citation-scheduler" onSubmit={submitCitation}><div className="section-title"><span className="step-number"><CalendarDays size={14} /></span><div><h2>Agendar representante</h2><p>Elige un cupo disponible; los horarios completos no se aceptan.</p></div></div><div className="scheduler-fields"><label className="field-label">Representante<select name="guardian_id" required defaultValue=""><option value="" disabled>Selecciona representante</option>{guardians.map((guardian) => <option key={guardian.id} value={guardian.id}>{guardian.full_name} · C.I. {guardian.document_id}</option>)}</select></label><label className="field-label">Fecha y hora<input name="scheduled_at" type="datetime-local" required defaultValue={scheduleDefault} /></label><label className="field-label">Motivo<input name="reason" required minLength={3} maxLength={2000} placeholder="Motivo de la citación" /></label><button className="submit-button" type="submit" disabled={busy || guardians.length === 0}>{busy ? 'Agendando…' : 'Agendar cita'}</button></div>{message && <p className={`form-message ${message.startsWith('Citación agendada') ? 'success' : ''}`} role="status">{message}</p>}</form>}<label className="agenda-search"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar representante, cédula o estudiante" /></label><div className="citation-list">{filtered.map((item) => <article className="citation-card" key={item.id}><div className="citation-info"><span className="citation-time">{new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(new Date(item.scheduled_at))}</span><span><strong>{item.guardian_name}</strong><small>{item.student_names} · C.I. {item.guardian_document}</small><small>{item.reason}</small></span><span className={`citation-status status-${item.status}`}>{item.status === 'pending' ? 'Pendiente' : item.status === 'attended' ? 'Atendido' : 'No asistió'}</span></div>{item.status === 'pending' && role !== 'guardian' && <div className="citation-actions"><button onClick={() => updateStatus(item.id, 'attended')}><Check size={16} />Atendido</button><button onClick={() => updateStatus(item.id, 'no_show')}><X size={16} />No asistió</button></div>}</article>)}{filtered.length === 0 && <div className="empty-state schedule-empty"><DoorOpen size={30} /><strong>{search ? 'No hay coincidencias' : 'Sin representantes citados hoy'}</strong><span>{search ? 'Prueba con otro nombre o documento.' : 'Las citas de hoy aparecerán aquí.'}</span></div>}</div></section>
}

function DashboardView({ token, setView }: { token: string; setView: (view: View) => void }) {
  const [reports, setReports] = useState<{ id: number; severity: string; description: string; occurred_at: string }[]>([])
  const [citations, setCitations] = useState<{ id: number; guardian_name: string; student_names: string; scheduled_at: string; status: string }[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([
      fetch('/api/reports', { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`/api/citations?day=${new Date().toLocaleDateString('en-CA')}&page=1&page_size=100`, { headers: { Authorization: `Bearer ${token}` } }),
    ]).then(async ([reportResponse, citationResponse]) => {
      if (!reportResponse.ok || !citationResponse.ok) throw new Error('No se pudo cargar el resumen del período.')
      const [reportData, citationData] = await Promise.all([reportResponse.json(), citationResponse.json()])
      setReports((reportData as ApiPage<{ id: number; severity: string; description: string; occurred_at: string }>).items)
      setCitations((citationData as ApiPage<{ id: number; guardian_name: string; student_names: string; scheduled_at: string; status: string }>).items)
    }).catch((reason: Error) => setError(reason.message))
  }, [token])

  const currentDate = new Date()
  const monthReports = reports.filter((report) => {
    const date = new Date(report.occurred_at)
    return date.getMonth() === currentDate.getMonth() && date.getFullYear() === currentDate.getFullYear()
  })
  const counts = ['leve', 'grave', 'muy_grave'].map((severity) => monthReports.filter((report) => report.severity === severity).length)
  const maxCount = Math.max(1, ...counts)

  return <section className="content-wrap"><div className="page-heading"><div><p className="eyebrow">RESUMEN ESCOLAR</p><h1>Convivencia escolar</h1><p className="page-subtitle">Seguimiento del período · {new Intl.DateTimeFormat('es', { month: 'long', year: 'numeric' }).format(currentDate)}</p></div><button className="submit-button compact" onClick={() => setView('Reportes')}><Plus size={17} />Nuevo reporte</button></div>{error && <p className="form-message" role="alert">{error}</p>}<div className="metric-grid"><div className="metric-card"><span>Reportes del mes</span><strong>{monthReports.length}</strong><small>Período actual</small><ClipboardList size={19} /></div><div className="metric-card"><span>Citaciones pendientes</span><strong>{citations.filter((item) => item.status === 'pending').length}</strong><small>Programadas para hoy</small><CalendarDays size={19} /></div><div className="metric-card"><span>Seguimiento prioritario</span><strong>{counts[2]}</strong><small>Reportes muy graves este mes</small><AlertTriangle size={19} /></div></div><div className="dashboard-lower"><div className="list-panel"><div className="panel-heading"><div><h2>Actividad reciente</h2><p>Últimos reportes registrados</p></div><button className="text-button" onClick={() => setView('Reportes')}>Nuevo reporte →</button></div>{reports.slice(0, 5).length ? reports.slice(0, 5).map((report) => <div className="activity-row" key={report.id}><span className={`activity-mark mark-${report.severity === 'leve' ? 0 : report.severity === 'grave' ? 1 : 2}`}><BookOpen size={16} /></span><span><strong>{report.description}</strong><small>{new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(report.occurred_at))}</small></span><span className={`activity-tag tag-${report.severity === 'leve' ? 0 : report.severity === 'grave' ? 1 : 2}`}>{report.severity.replace('_', ' ')}</span></div>) : <p className="portal-empty">Aún no hay reportes registrados.</p>}</div><div className="list-panel focus-panel"><div className="panel-heading"><div><h2>Por nivel</h2><p>Reportes de este mes</p></div></div>{['Leves', 'Graves', 'Muy graves'].map((label, index) => <div className="bar-row" key={label}><div><span>{label}</span><strong>{counts[index]}</strong></div><div className="bar-track"><i style={{ width: `${counts[index] / maxCount * 100}%` }} className={`bar-fill fill-${index}`} /></div></div>)}</div></div></section>
}

function DirectoryView({ token, setView }: { token: string; setView: (view: View) => void }) {
  const [activeId, setActiveId] = useState<number | null>(null)
  const [profile, setProfile] = useState<StudentProfile | null>(null)
  const [profileVersion, setProfileVersion] = useState(0)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [directory, setDirectory] = useState<ApiPage<Student>>({ items: [], page: 1, page_size: 10, total: 0, pages: 0 })

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ page: String(page), page_size: '10' })
      if (search.trim()) query.set('q', search.trim())
      fetch(`/api/students?${query}`, { headers: { Authorization: `Bearer ${token}` } })
        .then(async (response) => {
          const data = await response.json()
          if (!response.ok) throw new Error(data.detail || 'No se pudo cargar el directorio.')
          setDirectory(data)
        })
        .catch((reason: Error) => setError(reason.message))
    }, 160)
    return () => window.clearTimeout(timer)
  }, [page, search, token])

  useEffect(() => {
    if (activeId === null) {
      setProfile(null)
      return
    }
    fetch(`/api/students/${activeId}/summary`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.detail || 'No se pudo cargar el expediente.')
        setProfile(data)
      })
      .catch((reason: Error) => setError(reason.message))
  }, [activeId, profileVersion, token])

  if (activeId && !profile && error) return <section className="content-wrap"><p className="form-message" role="alert">{error}</p><button className="secondary-button" onClick={() => { setError(''); setActiveId(null) }}>Volver al directorio</button></section>
  if (activeId && !profile) return <section className="content-wrap"><p className="admin-inline-note">Cargando expediente…</p></section>
  if (activeId && profile) return <StudentProfileView profile={profile} token={token} onBack={() => setActiveId(null)} onChanged={() => { setProfile(null); setProfileVersion((version) => version + 1) }} />

  if (activeId && profile) return <section className="content-wrap"><div className="page-heading"><div><p className="eyebrow">EXPEDIENTE · RESUMEN 360°</p><h1>{profile.student.first_name} {profile.student.last_name}</h1><p className="page-subtitle">{profile.student.section} · C.I. {profile.student.document_id}</p></div><button className="secondary-button" onClick={() => setActiveId(null)}>← Directorio</button></div><div className="student-profile-grid"><article className="profile-card qr-card"><QRCodeSVG value={profile.student.qr_token} size={138} level="M" includeMargin /><strong>Código de identificación</strong><small>Token QR privado del sistema</small></article><div className="portal-metrics">{(['leve', 'grave', 'muy_grave'] as const).map((level, index) => <div className={`portal-metric metric-severity-${index}`} key={level}><span>{['Leves', 'Graves', 'Muy graves'][index]}</span><strong>{profile.severity_counts[level] ?? 0}</strong></div>)}</div><article className="list-panel profile-guardians"><div className="panel-heading"><div><h2>Representantes</h2><p>Contactos vinculados</p></div></div>{profile.guardians.map((guardian) => <div className="guardian-contact" key={guardian.document_id}><strong>{guardian.full_name}</strong><small>C.I. {guardian.document_id} · {guardian.phone || 'Sin teléfono'}</small><small>{guardian.email || 'Sin correo registrado'}</small></div>)}</article><article className="list-panel profile-history"><div className="panel-heading"><div><h2>Historial de convivencia</h2><p>Reportes y seguimiento cronológico</p></div></div>{profile.reports.length ? profile.reports.map((report) => <div className="profile-event" key={report.id}><span className={`event-level event-${report.severity}`} /><div><strong>{report.severity.replace('_', ' ')} · {report.subject || report.location || 'Incidente registrado'}</strong><p>{report.description}</p><small>{new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(report.occurred_at))}</small></div></div>) : <p className="portal-empty">Sin reportes registrados.</p>}</article></div></section>

  return <section className="content-wrap"><div className="page-heading"><div><p className="eyebrow">DIRECTORIO</p><h1>Estudiantes</h1><p className="page-subtitle">{directory.total} estudiantes registrados · busca y abre el expediente.</p></div><button className="secondary-button" onClick={() => setView('Importar datos')}><FileUp size={17} />Importar</button></div><label className="agenda-search"><Search size={18} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder="Buscar nombre o documento" /></label>{error && <p className="form-message">{error}</p>}<div className="list-panel">{directory.items.length ? directory.items.map((student) => <button className="directory-row directory-button" key={student.id} onClick={() => { setError(''); setProfile(null); setActiveId(student.id) }}><span className="student-avatar">{student.first_name[0]}{student.last_name[0]}</span><span><strong>{student.first_name} {student.last_name}</strong><small>{student.section_name} · C.I. {student.document_id}</small></span><QrCode size={18} /></button>) : <div className="empty-state"><GraduationCap size={28} /><strong>{search ? 'No hay coincidencias' : 'Sin estudiantes cargados'}</strong><span>{search ? 'Prueba otro nombre o documento.' : 'Añade alumnos desde Administración o Excel.'}</span></div>}</div><div className="directory-pagination"><span>{directory.total} alumnos · página {directory.page} de {Math.max(directory.pages, 1)}</span><div><button className="icon-button" aria-label="Página anterior" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={18} /></button><button className="icon-button" aria-label="Página siguiente" disabled={page >= directory.pages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={18} /></button></div></div></section>
}

export default App
