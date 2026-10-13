import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Check, ChevronLeft, ChevronRight, LoaderCircle, Pencil, Plus, RotateCcw, Trash2, UserPlus, Users, X } from 'lucide-react'

type AdminTab = 'Usuarios' | 'Estudiantes' | 'Representantes' | 'Cursos y materias'
type Page<T> = { items: T[]; page: number; page_size: number; total: number; pages: number }
type Section = { id: number; year_level: number; name: string; active: boolean; teacher_id: number | null; teacher_name: string | null }
type Guardian = { id: number; full_name: string; document_id: string; phone: string | null; email: string | null; active: boolean; student_ids: number[]; student_names: string }
type Student = { id: number; first_name: string; last_name: string; document_id: string; section_name: string; section_id: number; guardian_ids: number[]; active: boolean }
type Subject = { id: number; name: string; active: boolean }
type UserAccount = { id: number; username: string; full_name: string; role: string; active: boolean; guardian_id: number | null }
type EntityKind = 'user' | 'student' | 'guardian' | 'section' | 'subject'
type Entity = UserAccount | Student | Guardian | Section | Subject

type Lookups = { sections: Section[]; guardians: Guardian[]; students: Student[]; subjects: Subject[]; users: UserAccount[] }

const roles = [
  { value: 'admin', label: 'Administrador' },
  { value: 'coordinator', label: 'Coordinador' },
  { value: 'teacher', label: 'Profesor' },
  { value: 'doorman', label: 'Portero' },
  { value: 'guardian', label: 'Representante' },
]
const roleNames: Record<string, string> = Object.fromEntries(roles.map((role) => [role.value, role.label]))
const tabs: AdminTab[] = ['Usuarios', 'Estudiantes', 'Representantes', 'Cursos y materias']
const PAGE_SIZE = 10

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  })
  if (response.status === 204) return undefined as T
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : data.detail?.message || 'No se pudo guardar la información.')
  return data as T
}

function params(page: number, search: string, includeInactive: boolean, pageSize = PAGE_SIZE) {
  const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) })
  if (search.trim()) query.set('q', search.trim())
  if (includeInactive) query.set('include_inactive', 'true')
  return query.toString()
}

function PageControls({ data, onPage }: { data: Page<unknown>; onPage: (page: number) => void }) {
  if (data.pages <= 1) return <p className="admin-page-total">{data.total} registros</p>
  return <div className="admin-pagination"><span>{data.total} registros · página {data.page} de {data.pages}</span><div><button type="button" aria-label="Página anterior" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}><ChevronLeft size={17} /></button><button type="button" aria-label="Página siguiente" disabled={data.page >= data.pages} onClick={() => onPage(data.page + 1)}><ChevronRight size={17} /></button></div></div>
}

function RecordRow({ children, active, onEdit, onDelete }: { children: ReactNode; active: boolean; onEdit: () => void; onDelete: () => void }) {
  return <article className={`admin-list-row ${active ? '' : 'inactive-row'}`}><div className="admin-row-data">{children}</div><div className="admin-row-actions"><button type="button" onClick={onEdit} aria-label="Editar registro" title="Editar"><Pencil size={15} /></button>{active ? <button type="button" className="delete-action" onClick={onDelete} aria-label="Desactivar registro" title="Desactivar"><Trash2 size={15} /></button> : <button type="button" onClick={onDelete} aria-label="Reactivar registro" title="Reactivar"><RotateCcw size={15} /></button>}</div></article>
}

function AdminPanel({ token, onStudentsChanged }: { token: string; onStudentsChanged: () => void }) {
  const [tab, setTab] = useState<AdminTab>('Usuarios')
  const [reloadKey, setReloadKey] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [includeInactive, setIncludeInactive] = useState(false)
  const [users, setUsers] = useState<Page<UserAccount>>({ items: [], page: 1, page_size: PAGE_SIZE, total: 0, pages: 0 })
  const [students, setStudents] = useState<Page<Student>>({ items: [], page: 1, page_size: PAGE_SIZE, total: 0, pages: 0 })
  const [guardians, setGuardians] = useState<Page<Guardian>>({ items: [], page: 1, page_size: PAGE_SIZE, total: 0, pages: 0 })
  const [sections, setSections] = useState<Page<Section>>({ items: [], page: 1, page_size: PAGE_SIZE, total: 0, pages: 0 })
  const [subjects, setSubjects] = useState<Page<Subject>>({ items: [], page: 1, page_size: PAGE_SIZE, total: 0, pages: 0 })
  const [lookups, setLookups] = useState<Lookups>({ sections: [], guardians: [], students: [], subjects: [], users: [] })
  const [editor, setEditor] = useState<{ kind: EntityKind; item: Entity } | null>(null)
  const [teacherRole, setTeacherRole] = useState(false)
  const [accountRole, setAccountRole] = useState('admin')
  const [message, setMessage] = useState('')
  const [success, setSuccess] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let current = true
    const timer = window.setTimeout(() => {
      const query = params(page, search, includeInactive)
      if (tab === 'Cursos y materias') {
        Promise.all([request<Page<Section>>(`/api/sections?${query}`, token), request<Page<Subject>>(`/api/subjects?${query}`, token)])
          .then(([sectionPage, subjectPage]) => { if (current) { setSections(sectionPage); setSubjects(subjectPage) } })
          .catch((error: Error) => { if (current) reportResult(error.message) })
        return
      }
      const path = { Usuarios: 'users', Estudiantes: 'students', Representantes: 'guardians' }[tab]
      request<Page<UserAccount | Student | Guardian | Section>>(`/api/${path}?${query}`, token).then((result) => {
        if (!current) return
        if (tab === 'Usuarios') setUsers(result as Page<UserAccount>)
        else if (tab === 'Estudiantes') setStudents(result as Page<Student>)
        else if (tab === 'Representantes') setGuardians(result as Page<Guardian>)
        else setSections(result as Page<Section>)
      }).catch((error: Error) => {
        if (current) reportResult(error.message)
      })
    }, 180)
    return () => { current = false; window.clearTimeout(timer) }
  }, [tab, page, search, includeInactive, reloadKey, token])

  useEffect(() => {
    let current = true
    const sectionRequest = ['Usuarios', 'Estudiantes', 'Cursos y materias'].includes(tab) ? request<Page<Section>>('/api/sections?page=1&page_size=100', token) : Promise.resolve({ items: [], page: 1, page_size: 100, total: 0, pages: 0 })
    const guardianRequest = ['Usuarios', 'Estudiantes'].includes(tab) ? request<Page<Guardian>>('/api/guardians?page=1&page_size=100', token) : Promise.resolve({ items: [], page: 1, page_size: 100, total: 0, pages: 0 })
    const studentRequest = tab === 'Representantes' ? request<Page<Student>>('/api/students?page=1&page_size=100', token) : Promise.resolve({ items: [], page: 1, page_size: 100, total: 0, pages: 0 })
    const subjectRequest = ['Usuarios', 'Cursos y materias'].includes(tab) ? request<Page<Subject>>('/api/subjects?page=1&page_size=100', token) : Promise.resolve({ items: [], page: 1, page_size: 100, total: 0, pages: 0 })
    const teacherRequest = tab === 'Cursos y materias' || tab === 'Usuarios' ? request<Page<UserAccount>>('/api/users?q=teacher&page=1&page_size=100', token) : Promise.resolve({ items: [], page: 1, page_size: 100, total: 0, pages: 0 })
    Promise.all([sectionRequest, guardianRequest, studentRequest, subjectRequest, teacherRequest]).then(([sectionPage, guardianPage, studentPage, subjectPage, teacherPage]) => {
      if (current) setLookups({ sections: sectionPage.items, guardians: guardianPage.items, students: studentPage.items, subjects: subjectPage.items, users: teacherPage.items })
    }).catch((error: Error) => { if (current) reportResult(error.message) })
    return () => { current = false }
  }, [tab, reloadKey, token])

  function reportResult(text: string, isSuccess = false) {
    setMessage(text)
    setSuccess(isSuccess)
  }

  function changeTab(value: AdminTab) {
    setTab(value)
    setPage(1)
    setSearch('')
    reportResult('')
  }

  function refresh() {
    setReloadKey((key) => key + 1)
  }

  async function deactivate(kind: EntityKind, item: Entity) {
    const names: Record<EntityKind, string> = { user: 'esta cuenta', student: 'este estudiante', guardian: 'este representante', section: 'este curso', subject: 'esta materia' }
    if (!window.confirm(`¿Desactivar ${names[kind]}? El historial relacionado se conservará.`)) return
    const id = item.id
    const route: Record<EntityKind, string> = { user: 'users', student: 'students', guardian: 'guardians', section: 'sections', subject: 'subjects' }
    try {
      await request(`/api/${route[kind]}/${id}`, token, { method: 'DELETE' })
      reportResult('Registro desactivado. El historial se conserva.', true)
      refresh()
      if (kind === 'student') onStudentsChanged()
    } catch (error) {
      reportResult(error instanceof Error ? error.message : 'No se pudo desactivar el registro.')
    }
  }

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setBusy(true)
    reportResult('')
    try {
      const role = String(form.get('role'))
      const user = await request<UserAccount>('/api/users', token, { method: 'POST', body: JSON.stringify({ username: form.get('username'), full_name: form.get('full_name'), password: form.get('password'), role, guardian_id: role === 'guardian' ? Number(form.get('guardian_id')) : null }) })
      if (role === 'teacher') await request(`/api/teachers/${user.id}/sections`, token, { method: 'POST', body: JSON.stringify({ section_id: Number(form.get('section_id')), subject_id: form.get('subject_id') ? Number(form.get('subject_id')) : null }) })
      formElement.reset()
      setAccountRole('admin')
      setTeacherRole(false)
      reportResult(`Cuenta de ${roleNames[role]} creada correctamente.`, true)
      refresh()
    } catch (error) {
      reportResult(error instanceof Error ? error.message : 'No se pudo crear el usuario.')
    } finally { setBusy(false) }
  }

  async function createStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setBusy(true)
    try {
      const item = await request<Student>('/api/students', token, { method: 'POST', body: JSON.stringify({ first_name: form.get('first_name'), last_name: form.get('last_name'), document_id: form.get('document_id'), section_id: Number(form.get('section_id')), guardian_ids: form.getAll('guardian_ids').map(Number) }) })
      formElement.reset()
      reportResult(`${item.first_name} ${item.last_name} quedó inscrito en ${item.section_name}.`, true)
      refresh()
      onStudentsChanged()
    } catch (error) { reportResult(error instanceof Error ? error.message : 'No se pudo crear el estudiante.') }
    finally { setBusy(false) }
  }

  async function createGuardian(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setBusy(true)
    try {
      const item = await request<{ full_name: string; linked_students: number }>('/api/guardians', token, { method: 'POST', body: JSON.stringify({ full_name: form.get('full_name'), document_id: form.get('document_id'), phone: form.get('phone') || null, email: form.get('email') || null, student_ids: form.getAll('student_ids').map(Number) }) })
      formElement.reset()
      reportResult(`${item.full_name} quedó vinculado a ${item.linked_students} estudiante(s).`, true)
      refresh()
    } catch (error) { reportResult(error instanceof Error ? error.message : 'No se pudo crear el representante.') }
    finally { setBusy(false) }
  }

  async function createSection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setBusy(true)
    try {
      const item = await request<Section>('/api/sections', token, { method: 'POST', body: JSON.stringify({ year_level: Number(form.get('year_level')), name: form.get('name'), teacher_id: form.get('teacher_id') ? Number(form.get('teacher_id')) : null }) })
      formElement.reset()
      reportResult(`Curso ${item.year_level}° ${item.name} creado.`, true)
      refresh()
    } catch (error) { reportResult(error instanceof Error ? error.message : 'No se pudo crear el curso.') }
    finally { setBusy(false) }
  }

  async function createSubject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setBusy(true)
    try {
      const item = await request<Subject>('/api/subjects', token, { method: 'POST', body: JSON.stringify({ name: form.get('name') }) })
      formElement.reset()
      reportResult(`Materia ${item.name} creada.`, true)
      refresh()
    } catch (error) { reportResult(error instanceof Error ? error.message : 'No se pudo crear la materia.') }
    finally { setBusy(false) }
  }

  return <section className="content-wrap admin-page">
    <div className="page-heading"><div><p className="eyebrow">ACCESO EXCLUSIVO · ADMINISTRADOR</p><h1>Administración</h1><p className="page-subtitle">Gestiona cuentas, matrículas, representantes y catálogo académico.</p></div><div className="admin-count"><Users size={17} />{users.total} cuentas</div></div>
    <div className="admin-tabs" role="tablist" aria-label="Gestión de registros">{tabs.map((item) => <button type="button" role="tab" aria-selected={tab === item} className={tab === item ? 'active' : ''} onClick={() => changeTab(item)} key={item}>{item}</button>)}</div>
    {message && <div className={`admin-message ${success ? 'success' : ''}`} role="status">{success && <Check size={16} />}{message}</div>}
    <label className="inactive-toggle"><input type="checkbox" checked={includeInactive} onChange={(event) => { setIncludeInactive(event.target.checked); setPage(1) }} />Incluir desactivados</label>

    {tab === 'Usuarios' && <div className="admin-grid"><form className="admin-form-panel" onSubmit={createUser}><div className="section-title"><span className="step-number"><UserPlus size={14} /></span><div><h2>Nueva cuenta</h2><p>Contraseña inicial mínima: 12 caracteres.</p></div></div><label className="field-label">Nombre completo<input name="full_name" required minLength={3} maxLength={160} /></label><label className="field-label">Usuario<input name="username" required minLength={3} maxLength={80} /></label><label className="field-label">Contraseña inicial<input name="password" type="password" required minLength={12} maxLength={200} /></label><label className="field-label">Rol<select name="role" required value={accountRole} onChange={(event) => { setAccountRole(event.target.value); setTeacherRole(event.target.value === 'teacher') }}>{roles.map((role) => <option value={role.value} key={role.value}>{role.label}</option>)}</select></label>{teacherRole && <><label className="field-label">Sección asignada<select name="section_id" required defaultValue=""><option value="" disabled>Selecciona curso</option>{lookups.sections.map((item) => <option key={item.id} value={item.id}>{item.year_level}° {item.name}</option>)}</select></label><label className="field-label">Materia<select name="subject_id" defaultValue=""><option value="">Sin materia</option>{lookups.subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></>}{accountRole === 'guardian' && <label className="field-label">Representante<select name="guardian_id" required defaultValue=""><option value="" disabled>Selecciona representante</option>{lookups.guardians.map((item) => <option key={item.id} value={item.id}>{item.full_name} · {item.document_id}</option>)}</select></label>}<button className="submit-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}Crear cuenta</button></form><section className="admin-list-panel"><ListHeader title="Cuentas" count={users.total} search={search} onSearch={(value) => { setSearch(value); setPage(1) }} /><div>{users.items.map((item) => <RecordRow key={item.id} active={item.active} onEdit={() => setEditor({ kind: 'user', item })} onDelete={() => void deactivate('user', item)}><span className="student-avatar">{item.full_name.slice(0, 2).toUpperCase()}</span><span><strong>{item.full_name}</strong><small>{item.username} · {roleNames[item.role]}</small></span>{!item.active && <span className="role-pill">Desactivada</span>}</RecordRow>)}</div><PageControls data={users} onPage={setPage} /></section></div>}

    {tab === 'Estudiantes' && <div className="admin-grid"><form className="admin-form-panel" onSubmit={createStudent}><div className="section-title"><span className="step-number"><Plus size={14} /></span><div><h2>Inscribir estudiante</h2><p>Curso obligatorio; QR generado al guardar.</p></div></div>{lookups.sections.length === 0 && <button className="admin-inline-action" type="button" onClick={() => changeTab('Cursos y materias')}>Primero crea un curso →</button>}<div className="admin-name-grid"><label className="field-label">Nombres<input name="first_name" required /></label><label className="field-label">Apellidos<input name="last_name" required /></label></div><label className="field-label">Documento<input name="document_id" required minLength={3} /></label><label className="field-label">Curso<select name="section_id" required defaultValue=""><option value="" disabled>Selecciona curso</option>{lookups.sections.map((item) => <option key={item.id} value={item.id}>{item.year_level}° {item.name}</option>)}</select></label><fieldset className="admin-check-list"><legend>Representantes <span>Opcional</span></legend>{lookups.guardians.map((item) => <label className="admin-check-row" key={item.id}><input type="checkbox" name="guardian_ids" value={item.id} /><span><strong>{item.full_name}</strong><small>{item.document_id}</small></span></label>)}{lookups.guardians.length === 0 && <p className="admin-inline-note">Registra primero un representante.</p>}</fieldset><button className="submit-button" disabled={busy || !lookups.sections.length}>{busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}Inscribir estudiante</button></form><section className="admin-list-panel"><ListHeader title="Estudiantes" count={students.total} search={search} onSearch={(value) => { setSearch(value); setPage(1) }} /><div>{students.items.map((item) => <RecordRow key={item.id} active={item.active} onEdit={() => setEditor({ kind: 'student', item })} onDelete={() => void deactivate('student', item)}><span className="student-avatar">{item.first_name[0]}{item.last_name[0]}</span><span><strong>{item.first_name} {item.last_name}</strong><small>{item.section_name} · {item.document_id}</small></span></RecordRow>)}</div><PageControls data={students} onPage={setPage} /></section></div>}

    {tab === 'Representantes' && <div className="admin-grid"><form className="admin-form-panel" onSubmit={createGuardian}><div className="section-title"><span className="step-number"><Users size={14} /></span><div><h2>Registrar representante</h2><p>Vincula los estudiantes ahora o después.</p></div></div><label className="field-label">Nombre completo<input name="full_name" required minLength={3} /></label><label className="field-label">Documento<input name="document_id" required minLength={3} /></label><div className="admin-name-grid"><label className="field-label">Teléfono<input name="phone" type="tel" /></label><label className="field-label">Correo<input name="email" type="email" /></label></div><fieldset className="admin-check-list"><legend>Estudiantes vinculados</legend>{lookups.students.map((item) => <label className="admin-check-row" key={item.id}><input type="checkbox" name="student_ids" value={item.id} /><span><strong>{item.first_name} {item.last_name}</strong><small>{item.section_name}</small></span></label>)}</fieldset><button className="submit-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}Registrar representante</button></form><section className="admin-list-panel"><ListHeader title="Representantes" count={guardians.total} search={search} onSearch={(value) => { setSearch(value); setPage(1) }} /><div>{guardians.items.map((item) => <RecordRow key={item.id} active={item.active} onEdit={() => setEditor({ kind: 'guardian', item })} onDelete={() => void deactivate('guardian', item)}><span className="student-avatar">{item.full_name.slice(0, 2).toUpperCase()}</span><span><strong>{item.full_name}</strong><small>{item.document_id} · {item.student_names || 'Sin estudiantes vinculados'}</small></span></RecordRow>)}</div><PageControls data={guardians} onPage={setPage} /></section></div>}

    {tab === 'Cursos y materias' && <><div className="admin-grid"><form className="admin-form-panel" onSubmit={createSection}><div className="section-title"><span className="step-number"><Plus size={14} /></span><div><h2>Crear curso</h2><p>Asocia un profesor responsable.</p></div></div><label className="field-label">Año<select name="year_level" required defaultValue=""><option value="" disabled>Selecciona año</option>{[1, 2, 3, 4, 5].map((year) => <option key={year} value={year}>{year}° año</option>)}</select></label><label className="field-label">Sección<input name="name" required placeholder="A, B, C" /></label><label className="field-label">Profesor responsable<select name="teacher_id" defaultValue=""><option value="">Sin profesor asignado</option>{lookups.users.map((item) => <option key={item.id} value={item.id}>{item.full_name}</option>)}</select></label><button className="submit-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}Crear curso</button></form><form className="admin-form-panel" onSubmit={createSubject}><div className="section-title"><span className="step-number"><Plus size={14} /></span><div><h2>Crear materia</h2><p>Catálogo de materias asignables.</p></div></div><label className="field-label">Nombre de materia<input name="name" required minLength={2} maxLength={100} /></label><button className="submit-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}Crear materia</button></form></div><div className="admin-grid admin-catalog-grids"><section className="admin-list-panel"><ListHeader title="Cursos" count={sections.total} search={search} onSearch={(value) => { setSearch(value); setPage(1) }} /><div>{sections.items.map((item) => <RecordRow key={item.id} active={item.active} onEdit={() => setEditor({ kind: 'section', item })} onDelete={() => void deactivate('section', item)}><span className="student-avatar">{item.year_level}°</span><span><strong>{item.year_level}° {item.name}</strong><small>{item.teacher_name || 'Sin profesor asignado'}</small></span></RecordRow>)}</div><PageControls data={sections} onPage={setPage} /></section><section className="admin-list-panel"><ListHeader title="Materias" count={subjects.total} search={search} onSearch={(value) => { setSearch(value); setPage(1) }} /><div>{subjects.items.map((item) => <RecordRow key={item.id} active={item.active} onEdit={() => setEditor({ kind: 'subject', item })} onDelete={() => void deactivate('subject', item)}><span className="student-avatar"><BookGlyph /></span><span><strong>{item.name}</strong></span></RecordRow>)}</div><PageControls data={subjects} onPage={setPage} /></section></div></>}
    {editor && <RecordEditor kind={editor.kind} item={editor.item} token={token} lookups={lookups} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); reportResult('Cambios guardados.', true); refresh(); onStudentsChanged() }} />}
  </section>
}

function ListHeader({ title, count, search, onSearch }: { title: string; count: number; search: string; onSearch: (value: string) => void }) {
  return <div className="admin-list-heading"><div><h2>{title}</h2><p>{count} registros</p></div><label className="admin-search"><span className="sr-only">Buscar {title.toLowerCase()}</span><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Buscar…" /></label></div>
}

function BookGlyph() {
  return <span aria-hidden="true" className="book-glyph">M</span>
}

function RecordEditor({ kind, item, token, lookups, onClose, onSaved }: { kind: EntityKind; item: Entity; token: string; lookups: Lookups; onClose: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const title = { user: 'Editar cuenta', student: 'Editar estudiante', guardian: 'Editar representante', section: 'Editar curso', subject: 'Editar materia' }[kind]
  const basePath = { user: 'users', student: 'students', guardian: 'guardians', section: 'sections', subject: 'subjects' }[kind]

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const data: Record<string, unknown> = { active: form.get('active') === 'on' }
    if (kind === 'user') {
      data.username = form.get('username')
      data.full_name = form.get('full_name')
      data.role = form.get('role')
      data.guardian_id = form.get('role') === 'guardian' ? Number(form.get('guardian_id')) : null
      if (form.get('password')) data.password = form.get('password')
    } else if (kind === 'student') {
      data.first_name = form.get('first_name')
      data.last_name = form.get('last_name')
      data.document_id = form.get('document_id')
      data.section_id = Number(form.get('section_id'))
      data.guardian_ids = form.getAll('guardian_ids').map(Number)
    } else if (kind === 'guardian') {
      data.full_name = form.get('full_name')
      data.document_id = form.get('document_id')
      data.phone = form.get('phone') || null
      data.email = form.get('email') || null
      data.student_ids = form.getAll('student_ids').map(Number)
    } else if (kind === 'section') {
      data.year_level = Number(form.get('year_level'))
      data.name = form.get('name')
      data.teacher_id = form.get('teacher_id') ? Number(form.get('teacher_id')) : null
    } else {
      data.name = form.get('name')
    }
    setBusy(true)
    setError('')
    try {
      await request(`/api/${basePath}/${item.id}`, token, { method: 'PATCH', body: JSON.stringify(data) })
      onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudieron guardar los cambios.')
    } finally { setBusy(false) }
  }

  return <div className="admin-modal-backdrop" role="presentation" onClick={onClose}><section className="admin-editor-modal" role="dialog" aria-modal="true" aria-labelledby="editor-title" onClick={(event) => event.stopPropagation()}><div className="admin-editor-heading"><div><p className="eyebrow">GESTIÓN DE REGISTROS</p><h2 id="editor-title">{title}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Cerrar edición"><X size={19} /></button></div><form className="admin-form-panel" onSubmit={submit}>
    {kind === 'user' && <><label className="field-label">Nombre completo<input name="full_name" required minLength={3} defaultValue={(item as UserAccount).full_name} /></label><label className="field-label">Nombre de usuario<input name="username" required minLength={3} defaultValue={(item as UserAccount).username} /></label><label className="field-label">Rol<select name="role" defaultValue={(item as UserAccount).role}>{roles.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label><label className="field-label">Representante vinculado<select name="guardian_id" defaultValue={(item as UserAccount).guardian_id ?? ''}><option value="">No aplica</option>{lookups.guardians.map((guardian) => <option key={guardian.id} value={guardian.id}>{guardian.full_name} · {guardian.document_id}</option>)}</select></label><label className="field-label">Nueva contraseña<input name="password" type="password" minLength={12} placeholder="Dejar vacío para conservarla" /></label></>}
    {kind === 'student' && <><div className="admin-name-grid"><label className="field-label">Nombres<input name="first_name" required defaultValue={(item as Student).first_name} /></label><label className="field-label">Apellidos<input name="last_name" required defaultValue={(item as Student).last_name} /></label></div><label className="field-label">Documento<input name="document_id" required defaultValue={(item as Student).document_id} /></label><label className="field-label">Curso<select name="section_id" defaultValue={(item as Student).section_id}>{lookups.sections.map((section) => <option key={section.id} value={section.id}>{section.year_level}° {section.name}</option>)}</select></label><fieldset className="admin-check-list"><legend>Representantes vinculados</legend>{lookups.guardians.map((guardian) => <label className="admin-check-row" key={guardian.id}><input name="guardian_ids" type="checkbox" value={guardian.id} defaultChecked={(item as Student).guardian_ids.includes(guardian.id)} /><span>{guardian.full_name}</span></label>)}</fieldset></>}
    {kind === 'guardian' && <><label className="field-label">Nombre completo<input name="full_name" required defaultValue={(item as Guardian).full_name} /></label><label className="field-label">Documento<input name="document_id" required defaultValue={(item as Guardian).document_id} /></label><div className="admin-name-grid"><label className="field-label">Teléfono<input name="phone" type="tel" defaultValue={(item as Guardian).phone ?? ''} /></label><label className="field-label">Correo<input name="email" type="email" defaultValue={(item as Guardian).email ?? ''} /></label></div><fieldset className="admin-check-list"><legend>Estudiantes vinculados</legend>{lookups.students.map((student) => <label className="admin-check-row" key={student.id}><input name="student_ids" type="checkbox" value={student.id} defaultChecked={(item as Guardian).student_ids.includes(student.id)} /><span>{student.first_name} {student.last_name} · {student.section_name}</span></label>)}</fieldset></>}
    {kind === 'section' && <><label className="field-label">Año<select name="year_level" defaultValue={(item as Section).year_level}>{[1, 2, 3, 4, 5].map((year) => <option key={year} value={year}>{year}° año</option>)}</select></label><label className="field-label">Sección<input name="name" required defaultValue={(item as Section).name} /></label><label className="field-label">Profesor responsable<select name="teacher_id" defaultValue={(item as Section).teacher_id ?? ''}><option value="">Sin profesor asignado</option>{lookups.users.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.full_name}</option>)}</select></label></>}
    {kind === 'subject' && <label className="field-label">Nombre de materia<input name="name" required defaultValue={(item as Subject).name} /></label>}
    <label className="admin-active-check"><input name="active" type="checkbox" defaultChecked={item.active} />Activo</label>{error && <p className="form-message" role="alert">{error}</p>}<div className="admin-editor-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button><button className="submit-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}Guardar cambios</button></div>
  </form></section></div>
}

export default AdminPanel
