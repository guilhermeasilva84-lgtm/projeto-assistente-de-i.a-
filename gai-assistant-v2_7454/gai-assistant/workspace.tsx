import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Activity, AudioWaveform, BookOpen, CalendarClock, CheckCircle2, Database, Download, FileSpreadsheet,
  FileText, FlaskConical, Inbox, LayoutDashboard, LogIn, LogOut, MessageSquareText, Plus,
  Search, Shield, Sparkles, Ticket, Timer, Trash2, TriangleAlert, UploadCloud, X,
} from 'lucide-react'
import { errorMessage } from './api'
import {
  authenticate, createTicket, downloadDocument, exportTickets, formatDateTime, getDocuments,
  getSummary, getTickets, logout, priorities, removeDocument, seedDemo, statusLabels, ticketCode,
  triageTicket, updateTicket, uploadDocument,
} from './workspaceApi'
import type {
  Account, Classification, LibraryDocument, Priority, Status, TicketInput, WorkTicket, WorkspaceSummary,
} from './workspaceApi'
import './workspace.css'

export const navigation = {
  overview: { label: 'Visão geral', icon: LayoutDashboard, hash: '#/inicio' },
  tickets: { label: 'Central de chamados', icon: Ticket, hash: '#/chamados' },
  library: { label: 'Biblioteca', icon: BookOpen, hash: '#/biblioteca' },
  chat: { label: 'Assistente', icon: MessageSquareText, hash: '#/assistente' },
} as const

export type Page = keyof typeof navigation
type WorkspaceEvent = WorkspaceSummary['events'][number]

const actions: Record<WorkspaceEvent['action'], { label: string; icon: typeof Ticket }> = {
  conversation_created: { label: 'Conversa iniciada', icon: MessageSquareText },
  ticket_created: { label: 'Chamado aberto', icon: Ticket },
  ticket_updated: { label: 'Chamado atualizado', icon: CheckCircle2 },
  document_added: { label: 'Documento adicionado', icon: FileText },
  document_removed: { label: 'Documento removido', icon: Trash2 },
  demo_loaded: { label: 'Dados de demonstração carregados', icon: FlaskConical },
}

function Banner({ children }: { children: ReactNode }) {
  return <p className="workspace-error" role="alert"><TriangleAlert size={16} />{children}</p>
}

function Empty({ icon: Icon, title, children }: { icon: typeof Ticket; title: string; children?: ReactNode }) {
  return <div className="workspace-empty"><Icon size={29} /><strong>{title}</strong>{children && <p>{children}</p>}</div>
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return <dialog className="workspace-dialog" ref={ref} onCancel={(event) => { event.preventDefault(); onClose() }} aria-label={title}>
    <div className="modal-heading">
      <h2>{title}</h2><button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}><X size={20} /></button>
    </div>
    {children}
  </dialog>
}

function PageHeading({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return <header className="workspace-heading">
    <div><h1>{title}</h1><p>{text}</p></div>
    {children && <div className="workspace-actions">{children}</div>}
  </header>
}

export function OverviewPage({ name, navigate, openTicket }: {
  name: string; navigate: (page: Page) => void; openTicket: () => void;
}) {
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null)
  const [error, setError] = useState('')
  const [seeding, setSeeding] = useState(false)
  useEffect(() => {
    let active = true
    getSummary().then((data) => { if (active) setSummary(data) }).catch((cause) => { if (active) setError(errorMessage(cause)) })
    return () => { active = false }
  }, [])

  async function loadDemo() {
    setSeeding(true)
    setError('')
    try {
      await seedDemo()
      setSummary(await getSummary())
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSeeding(false)
    }
  }

  const total = summary ? Object.values(summary.statuses).reduce((sum, current) => sum + current, 0) : 0
  const metrics = [
    { label: 'Chamados ativos', value: summary?.active, icon: Ticket, tone: 'mint', page: 'tickets' },
    { label: 'Prioridade alta ou crítica', value: summary?.urgent, icon: TriangleAlert, tone: 'amber', page: 'tickets' },
    { label: 'Prazo vencido', value: summary?.overdue, icon: Timer, tone: 'rose', page: 'tickets' },
    { label: 'Documentos na biblioteca', value: summary?.documents, icon: BookOpen, tone: 'blue', page: 'library' },
  ] as const

  return <section className="workspace-page overview-page">
    <PageHeading title="Visão geral" text="Acompanhe a operação e acesse as ferramentas de TI.">
      {(!summary || !summary.demo_loaded) &&
        <button className="workspace-button" onClick={() => void loadDemo()} disabled={seeding || !summary}>
          <FlaskConical size={17} /> {seeding ? 'Carregando…' : 'Carregar dados de demonstração'}
        </button>}
      <button className="workspace-button primary" onClick={openTicket}><Plus size={18} /> Novo chamado</button>
    </PageHeading>
    {error && <Banner>{error}</Banner>}
    <div className="overview-hero">
      <div className="overview-hero-content">
        <span className="overview-kicker"><AudioWaveform size={14} /> Copiloto corporativo de TI</span>
        <h2>Olá, {name.split(' ')[0]}.</h2>
        <p>Consulte a biblioteca, organize chamados e use o assistente para resolver tarefas técnicas.</p>
        <button className="workspace-button" onClick={() => navigate('chat')}><Sparkles size={16} /> Abrir assistente</button>
      </div>
      <div className="overview-art" aria-hidden="true">
        <div className="overview-ring r1" /><div className="overview-ring r2" /><div className="overview-ring r3" />
        <div className="overview-art-center"><AudioWaveform size={43} /></div>
        <span className="overview-art-node n1"><Ticket size={20} /></span>
        <span className="overview-art-node n2"><BookOpen size={20} /></span>
        <span className="overview-art-node n3"><Database size={17} /></span>
      </div>
    </div>
    <div className="workspace-metrics">
      {metrics.map(({ icon: Icon, label, value, tone, page }) => <button key={label}
        onClick={() => navigate(page)} className="metric-card">
        <span className={`workspace-icon ${tone}`}><Icon size={18} /></span>
        <strong>{value ?? '–'}</strong><span>{label}</span>
      </button>)}
    </div>
    <div className="dashboard-grid">
      <section className="workspace-card status-chart">
        <div className="card-heading"><div><h2>Fluxo de chamados</h2><p>{total} chamado(s) no espaço</p></div><Activity size={20} /></div>
        {(Object.keys(statusLabels) as Status[]).map((status) => {
          const count = summary?.statuses[status] ?? 0
          return <div className="status-row" key={status}>
            <span>{statusLabels[status]}</span>
            <div className="chart-track"><div className={`chart-fill ${status}`} style={{ width: `${total ? 100 * count / total : 0}%` }} /></div>
            <strong>{count}</strong>
          </div>
        })}
      </section>
      <section className="workspace-card">
        <div className="card-heading"><div><h2>Atividade recente</h2><p>{summary?.conversations ?? 0} conversa(s) salvas</p></div><CalendarClock size={20} /></div>
        {summary?.events.length ? <ul className="activity-list">
          {summary.events.map((event) => {
            const item = actions[event.action]
            const Icon = item?.icon ?? Activity
            return <li key={event.id}><span className="workspace-icon"><Icon size={16} /></span><div>
              <strong>{item?.label ?? 'Registro atualizado'}</strong><small>{event.target}</small>
            </div><time dateTime={event.created_at}>{formatDateTime(event.created_at)}</time></li>
          })}
        </ul> : <Empty icon={Activity} title="Ainda sem atividade">As novas conversas, alterações e inclusões aparecem aqui.</Empty>}
      </section>
    </div>
  </section>
}

export const blankTicket: TicketInput = {
  title: '', description: '', system: 'Não informado', category: 'Suporte técnico', priority: 'Média', status: 'open',
}

export function draftFromClassification(description: string, classification: Classification): TicketInput {
  return {
    ...blankTicket, title: description.trim().split('\n')[0].slice(0, 140), description: description.slice(0, 5000),
    category: classification.categoria.slice(0, 80) || blankTicket.category,
    system: classification.sistema.slice(0, 80) || blankTicket.system, priority: classification.prioridade,
  }
}

interface TicketDraft {
  input: TicketInput
  existing?: WorkTicket
}

function TicketEditor({ draft, close, save }: {
  draft: TicketDraft; close: () => void; save: (item: WorkTicket) => void;
}) {
  const [input, setInput] = useState(draft.input)
  const [classification, setClassification] = useState<{ classification: Classification; origin: string } | null>(null)
  const [busy, setBusy] = useState<'triage' | 'save' | null>(null)
  const [error, setError] = useState('')
  const update = (field: keyof TicketInput, value: string) => setInput((previous) => ({ ...previous, [field]: value }))

  async function suggest() {
    setBusy('triage')
    setError('')
    try {
      const result = await triageTicket(input.description)
      setClassification(result)
      setInput((previous) => ({
        ...previous,
        category: result.classification.categoria.slice(0, 80) || blankTicket.category,
        system: result.classification.sistema.slice(0, 80) || blankTicket.system,
        priority: result.classification.prioridade,
      }))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy('save')
    setError('')
    try {
      const item = draft.existing
        ? await updateTicket(draft.existing.id, draft.existing.version, input)
        : await createTicket(input)
      save(item)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  return <Modal title={draft.existing ? ticketCode(draft.existing.id) : 'Novo chamado'} onClose={() => { if (!busy) close() }}>
    <form className="workspace-form" onSubmit={(event) => void submit(event)}>
      {error && <Banner>{error}</Banner>}
      {draft.existing && <p className="form-meta">
        <CalendarClock size={16} /> Prazo em {formatDateTime(draft.existing.due_at)}
        {draft.existing.resolved_at && ` · Resolvido em ${formatDateTime(draft.existing.resolved_at)}`}
      </p>}
      <label>Título<input required minLength={4} maxLength={140} value={input.title} onChange={(event) => update('title', event.target.value)} disabled={!!busy} /></label>
      <label>Descrição<textarea required minLength={4} maxLength={5000} rows={4} value={input.description} onChange={(event) => update('description', event.target.value)} disabled={!!busy} /></label>
      <button className="workspace-button align-start" type="button" disabled={!!busy || input.description.trim().length < 4}
        onClick={() => void suggest()}><Sparkles size={16} /> {busy === 'triage' ? 'Analisando…' : 'Sugerir triagem'}</button>
      {classification && <div className="triage-result">
        <strong>{classification.origin === 'openai' ? 'Sugestão do GPT' : 'Sugestão por regras'}</strong>
        <p>{classification.classification.justificativa} {classification.classification.proxima_acao}</p>
      </div>}
      <div className="form-columns">
        <label>Sistema<input required maxLength={80} value={input.system} onChange={(event) => update('system', event.target.value)} disabled={!!busy} /></label>
        <label>Categoria<input required maxLength={80} value={input.category} onChange={(event) => update('category', event.target.value)} disabled={!!busy} /></label>
        <label>Prioridade<select value={input.priority} onChange={(event) => update('priority', event.target.value)} disabled={!!busy}>
          {priorities.map((priority) => <option key={priority}>{priority}</option>)}
        </select></label>
        <label>Situação<select value={input.status} onChange={(event) => update('status', event.target.value)} disabled={!!busy}>
          {Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select></label>
      </div>
      <footer className="form-footer"><button type="button" className="workspace-button" disabled={!!busy} onClick={close}>Cancelar</button>
        <button className="workspace-button primary" disabled={!!busy}>{busy === 'save' ? 'Salvando…' : 'Salvar chamado'}</button></footer>
    </form>
  </Modal>
}

const priorityTones: Record<Priority, string> = { Baixa: 'blue', Média: 'mint', Alta: 'amber', Crítica: 'rose' }

export function TicketsPage({ initialDraft, clearDraft }: { initialDraft: TicketInput | null; clearDraft: () => void; }) {
  const [tickets, setTickets] = useState<WorkTicket[]>([])
  const [draft, setDraft] = useState<TicketDraft | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  useEffect(() => {
    let active = true
    getTickets().then((items) => { if (active) setTickets(items) }).catch((cause) => { if (active) setError(errorMessage(cause)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (initialDraft) {
      setDraft({ input: initialDraft })
      clearDraft()
    }
  }, [initialDraft, clearDraft])

  async function exportTable() {
    setExporting(true)
    setError('')
    try {
      await exportTickets()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setExporting(false)
    }
  }

  function saveTicket(item: WorkTicket) {
    setDraft(null)
    setTickets((previous) => [item, ...previous.filter(({ id }) => id !== item.id)])
    setMessage(`${ticketCode(item.id)} salvo.`)
  }

  const normalizedSearch = search.trim().toLocaleLowerCase('pt-BR')
  const visible = tickets.filter((item) => (filter === 'all' || item.status === filter) &&
    (!normalizedSearch || [item.title, item.system, item.category, ticketCode(item.id)]
      .some((value) => value.toLocaleLowerCase('pt-BR').includes(normalizedSearch))))

  return <section className="workspace-page">
    <PageHeading title="Central de chamados" text="Registre incidentes e acompanhe os prazos de resolução.">
      <button className="workspace-button" disabled={!tickets.length || exporting} onClick={() => void exportTable()}><Download size={17} /> Exportar CSV</button>
      <button className="workspace-button primary" onClick={() => setDraft({ input: { ...blankTicket } })}><Plus size={18} /> Novo chamado</button>
    </PageHeading>
    {error && <Banner>{error}</Banner>}
    {message && <p className="workspace-success" role="status"><CheckCircle2 size={17} />{message}</p>}
    <section className="workspace-card desk-table-card" aria-label="Chamados">
      <div className="desk-toolbar">
        <label className="desk-search"><Search size={17} /><input type="search" value={search} placeholder="Buscar por título, sistema ou ID" onChange={(event) => setSearch(event.target.value)} aria-label="Buscar chamados" /></label>
        <label className="desk-filter"><span>Situação</span><select value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="all">Todas</option>{Object.entries(statusLabels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
        </select></label>
      </div>
      {loading ? <Empty icon={Ticket} title="Carregando chamados…" /> :
        visible.length ? <div className="desk-table-scroll"><table>
          <thead><tr><th>Chamado</th><th>Sistema</th><th>Prioridade</th><th>Situação</th><th>Prazo</th></tr></thead>
          <tbody>{visible.map((item) => <tr key={item.id}>
            <td><button className="ticket-link" onClick={() => setDraft({ input: item, existing: item })}>
              <strong>{item.title}</strong><small>{ticketCode(item.id)} · {item.category}</small></button></td>
            <td>{item.system}</td>
            <td><span className={`desk-badge ${priorityTones[item.priority]}`}>{item.priority}</span></td>
            <td><span className={`desk-badge status-${item.status}`}>{statusLabels[item.status]}</span></td>
            <td><time dateTime={item.due_at}>{formatDateTime(item.due_at)}</time>
              {item.overdue && <small className="late-label">{item.resolved_at ? 'Resolvido fora do prazo' : 'Prazo vencido'}</small>}</td>
          </tr>)}</tbody>
        </table></div> : <Empty icon={Inbox} title={tickets.length ? 'Nenhum chamado encontrado' : 'Nenhum chamado registrado'}>
          {tickets.length ? 'Tente outro termo ou uma situação diferente.' : 'Crie um chamado ou carregue os dados fictícios na visão geral.'}
        </Empty>}
    </section>
    {draft && <TicketEditor draft={draft} close={() => setDraft(null)} save={saveTicket} />}
  </section>
}

function UploadDialog({ close, save }: { close: () => void; save: (item: LibraryDocument) => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  function choose(selected?: File) {
    if (!selected) return
    if (!/\.(pdf|xlsx)$/i.test(selected.name) || !selected.size || selected.size > 8 * 1024 * 1024) {
      setError('Escolha um PDF ou uma planilha .xlsx com até 8 MB.')
      return
    }
    setError('')
    setFile(selected)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!file) return
    setBusy(true)
    setError('')
    try {
      save(await uploadDocument(file, description))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return <Modal title="Adicionar à biblioteca" onClose={() => { if (!busy) close() }}>
    <form className="workspace-form" onSubmit={(event) => void submit(event)}>
      {error && <Banner>{error}</Banner>}
      <label className="upload-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
        event.preventDefault()
        if (!busy) choose(event.dataTransfer.files[0])
      }}>
        <UploadCloud size={25} /><strong>{file ? file.name : 'Selecionar ou soltar arquivo'}</strong><span>PDF com texto ou Excel (.xlsx), até 8 MB</span>
        <input className="sr-only" type="file" accept=".pdf,.xlsx" disabled={busy}
          onChange={(event) => { choose(event.target.files?.[0]); event.target.value = '' }} />
      </label>
      <label>Descrição opcional<input maxLength={240} value={description} placeholder="Ex. procedimento de recuperação de acesso"
        onChange={(event) => setDescription(event.target.value)} disabled={busy} /></label>
      <footer className="form-footer"><button type="button" className="workspace-button" disabled={busy} onClick={close}>Cancelar</button>
        <button className="workspace-button primary" disabled={busy || !file}>{busy ? 'Processando…' : 'Adicionar documento'}</button></footer>
    </form>
  </Modal>
}

export function LibraryPage({ useDocument, queryLibrary }: {
  useDocument: (document: LibraryDocument) => void; queryLibrary: () => void;
}) {
  const [documents, setDocuments] = useState<LibraryDocument[]>([])
  const [showUpload, setShowUpload] = useState(false)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    let active = true
    getDocuments().then((items) => { if (active) setDocuments(items) }).catch((cause) => { if (active) setError(errorMessage(cause)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  async function updateDocument(document: LibraryDocument, remove: boolean) {
    if (remove && !window.confirm(`Remover “${document.name}” da biblioteca?`)) return
    setUpdating(document.id)
    setError('')
    try {
      if (remove) {
        await removeDocument(document.id)
        setDocuments((items) => items.filter(({ id }) => id !== document.id))
        setMessage('Documento removido da biblioteca.')
      } else {
        await downloadDocument(document.id, document.name)
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setUpdating(null)
    }
  }

  return <section className="workspace-page">
    <PageHeading title="Biblioteca" text="Mantenha procedimentos e planilhas disponíveis para consulta no assistente.">
      <button className="workspace-button" disabled={!documents.length} onClick={queryLibrary}><Sparkles size={17} /> Consultar biblioteca</button>
      <button className="workspace-button primary" onClick={() => setShowUpload(true)}><Plus size={19} /> Adicionar documento</button>
    </PageHeading>
    {error && <Banner>{error}</Banner>}
    {message && <p className="workspace-success" role="status"><CheckCircle2 size={17} />{message}</p>}
    {loading ? <Empty icon={BookOpen} title="Carregando biblioteca…" /> : !documents.length ? <div className="workspace-card">
      <Empty icon={BookOpen} title="Sua biblioteca está vazia">Adicione um arquivo ou use o acervo fictício disponível na visão geral.</Empty>
    </div> : <div className="library-grid">
      {documents.map((item) => {
        const Icon = item.kind === 'pdf' ? FileText : FileSpreadsheet
        return <article className="workspace-card library-card" key={item.id}>
          <div className="library-card-top">
            <span className={`workspace-icon ${item.kind === 'pdf' ? 'blue' : 'mint'}`}><Icon size={22} /></span>
            <span className="desk-badge">{item.kind === 'pdf' ? 'PDF' : 'Excel'}</span>
          </div>
          <h2>{item.name}</h2>
          {item.description && <p>{item.description}</p>}
          <small>{item.units} {item.kind === 'pdf' ? 'pág.' : 'aba(s)'} · {Math.max(1, Math.round(item.size / 1024))} KB</small>
          <footer>
            <button className="workspace-button" onClick={() => useDocument(item)}><Sparkles size={15} /> Analisar arquivo</button>
            <button className="icon-button" disabled={!!updating} onClick={() => void updateDocument(item, false)} aria-label={`Baixar ${item.name}`}><Download size={17} /></button>
            <button className="icon-button danger" disabled={!!updating} onClick={() => void updateDocument(item, true)} aria-label={`Remover ${item.name}`}><Trash2 size={16} /></button>
          </footer>
        </article>
      })}
    </div>}
    {showUpload && <UploadDialog close={() => setShowUpload(false)} save={(item) => {
      setDocuments((documents) => [item, ...documents])
      setShowUpload(false)
      setMessage('Documento adicionado à biblioteca.')
    }} />}
  </section>
}

export function AccountDialog({ account, onClose, onChange }: {
  account: Account | null; onClose: () => void; onChange: (account: Account | null) => void;
}) {
  const [operation, setOperation] = useState<'login' | 'register'>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      onChange(await authenticate(operation, { name, email, password }))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    setBusy(true)
    setError('')
    try {
      await logout()
      onChange(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const close = () => { if (!busy) onClose() }
  return <Modal title={account ? 'Minha conta' : operation === 'register' ? 'Criar conta' : 'Entrar no GAI'} onClose={close}>
    {account ? <div className="workspace-form">
      {error && <Banner>{error}</Banner>}
      <p className="account-intro"><Shield size={22} /><span><strong>{account.name}</strong><small>{account.email}</small></span></p>
      <button className="workspace-button align-start" disabled={busy} onClick={() => void signOut()}><LogOut size={17} /> Sair da conta</button>
    </div> : <form className="workspace-form" onSubmit={(event) => void submit(event)}>
      <p className="form-meta">A conta guarda seu espaço de trabalho e permite acessá-lo em outro navegador.</p>
      {error && <Banner>{error}</Banner>}
      {operation === 'register' && <label>Nome<input autoComplete="name" required minLength={2} maxLength={100} value={name} onChange={(event) => setName(event.target.value)} disabled={busy} /></label>}
      <label>E-mail<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} /></label>
      <label>Senha<input type="password" autoComplete={operation === 'register' ? 'new-password' : 'current-password'} minLength={10} maxLength={128} required value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} /></label>
      {operation === 'register' && <p className="form-meta">Use 10 caracteres ou mais.</p>}
      <footer className="form-footer">
        <button className="workspace-button" type="button" disabled={busy} onClick={() => {
          setOperation(operation === 'login' ? 'register' : 'login'); setError('')
        }}>{operation === 'login' ? 'Criar conta' : 'Voltar para entrar'}</button>
        <button className="workspace-button primary" disabled={busy}><LogIn size={17} /> {busy ? 'Aguarde…' : operation === 'login' ? 'Entrar' : 'Cadastrar'}</button>
      </footer>
    </form>}
  </Modal>
}
