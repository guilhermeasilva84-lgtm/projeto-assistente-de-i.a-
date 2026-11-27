import { StrictMode, useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { createRoot } from 'react-dom/client'
import {
  AudioWaveform, BookOpen, Check, ChevronDown, ChevronRight, CircleHelp,
  CodeXml, Database, Download, FileSpreadsheet, FileText, Globe2, Menu, MessageSquareText,
  Paperclip, Plus, Radio, Send, Settings2, Shield, Sparkles, Ticket, X,
} from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  errorMessage, getConfig, getConversation, getConversations, sendMessage,
} from './api'
import type { Config, Conversation, Message, Mode } from './api'
import {
  AccountDialog, LibraryPage, OverviewPage, TicketsPage, blankTicket, draftFromClassification, navigation,
} from './workspace'
import type { Page } from './workspace'
import { downloadBlob, downloadDocument, getAccount } from './workspaceApi'
import type { Account, Classification, LibraryDocument, TicketInput } from './workspaceApi'
import './styles.css'

const tools = [
  { mode: 'web', label: 'Pesquisar na web', description: 'Encontre informações atuais com fontes.', icon: Globe2, tone: 'mint', prompt: 'Qual é a versão LTS mais recente do Java?' },
  { mode: 'document', label: 'Analisar documento', description: 'Extraia dados de PDFs e planilhas Excel.', icon: FileText, tone: 'blue', prompt: 'Resuma este documento.' },
  { mode: 'sql', label: 'Gerar SQL', description: 'Transforme uma pergunta em uma consulta.', icon: Database, tone: 'violet', prompt: 'Liste todos os clientes ativos.' },
  { mode: 'ticket', label: 'Analisar chamado', description: 'Classifique o sistema e a prioridade.', icon: Ticket, tone: 'amber', prompt: 'TOTVS está retornando erro de login.' },
  { mode: 'code', label: 'Gerar código', description: 'Crie um exemplo de código.', icon: CodeXml, tone: 'blue', prompt: 'Crie uma API REST em Node.js.' },
  { mode: 'knowledge', label: 'Consultar biblioteca', description: 'Busque respostas nos arquivos cadastrados.', icon: BookOpen, tone: 'mint', prompt: 'Qual é o procedimento para falha de login no TOTVS?' },
] as const
const modeLabels = Object.fromEntries(tools.map((tool) => [tool.mode, tool.label]))
const defaultModels = [{ id: 'gpt-5', label: 'GPT-5' }, { id: 'gpt-5-mini', label: 'GPT-5 mini' }]
const keyForAccount = (account: Account | null | undefined) =>
  account ? `gai-active-conversation-${account.id}` : 'gai-active-conversation'

function pageFromHash(): Page {
  return (Object.keys(navigation) as Page[]).find((key) => navigation[key].hash === window.location.hash) ?? 'overview'
}

function Brand({ className = '' }: { className?: string }) {
  return <span className={`brand-mark ${className}`}><AudioWaveform aria-hidden="true" /></span>
}

function Welcome({ name, selectTool }: { name: string; selectTool: (mode: Mode) => void }) {
  return (
    <section className="welcome">
      <div className="hero">
        <div className="hero-content">
          <p className="eyebrow"><Sparkles size={14} /> Copiloto corporativo de TI</p>
          <h1>Como posso ajudar,<br /><span>{name.split(' ')[0]}?</span></h1>
          <p className="hero-description">Pesquise, analise arquivos e resolva tarefas de TI em um só lugar.</p>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="diagram-grid" />
          <div className="orbit orbit-outer" />
          <div className="orbit orbit-middle" />
          <div className="orbit orbit-inner" />
          <div className="axis axis-x" />
          <div className="axis axis-y" />
          <i className="orbit-point point-top" /><i className="orbit-point point-left" /><i className="orbit-point point-bottom" />
          <div className="floating-icon floating-doc"><FileText size={17} /></div>
          <div className="floating-icon floating-db"><Database size={17} /></div>
          <div className="floating-icon floating-search"><Globe2 size={16} /></div>
          <Brand className="hero-mark" />
        </div>
      </div>
      <div className="starter-heading"><h2>O que você quer fazer?</h2></div>
      <div className="tool-grid">
        {tools.slice(0, 4).map(({ mode, label, description, icon: Icon, tone }) => (
          <button className="tool-card" key={mode} onClick={() => selectTool(mode)}>
            <span className={`tool-icon ${tone}`}><Icon size={20} strokeWidth={1.65} /></span>
            <span className="tool-card-copy"><strong>{label}</strong><small>{description}</small></span>
          </button>
        ))}
      </div>
    </section>
  )
}

function MessageBlock({ message, original, convertTicket }: {
  message: Message; original?: string; convertTicket: (description: string, classification: Classification) => void;
}) {
  const [copied, setCopied] = useState(false)
  const [downloadError, setDownloadError] = useState('')
  const responseType = message.origin ? ({
    demo: 'Demonstração', local: 'Processamento local', web: 'Pesquisa web', openai: 'OpenAI',
  } as Record<string, string>)[message.origin] : null
  async function copy() {
    try {
      await navigator.clipboard.writeText(message.text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }
  async function downloadSource(item: NonNullable<Message['knowledge_sources']>[number]) {
    setDownloadError('')
    try {
      await downloadDocument(item.document_id, item.title)
    } catch {
      setDownloadError('O arquivo não está disponível na biblioteca.')
    }
  }
  return (
    <article className={`message message-${message.role}`}>
      {message.role === 'assistant' && <Brand />}
      <div className="message-content">
        <div className="message-heading">
          <strong>{message.role === 'user' ? 'Você' : 'GAI Assistant'}</strong>
          {responseType && <span>{responseType}</span>}
        </div>
        {message.attachment && <p className="message-attachment"><FileText size={14} /> {message.attachment}</p>}
        {message.role === 'user' ? <p className="user-text">{message.text}</p> : (
          <>
            <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} disallowedElements={['img']}>{message.text}</Markdown></div>
            {!!message.sources?.length && (
              <ul className="sources">
                {message.sources.map((source, index) => (
                  <li key={`${source.url}-${index}`}>
                    <a href={source.url} target="_blank" rel="noopener noreferrer">
                      <span>{index + 1}</span>{source.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {!!message.knowledge_sources?.length && <ul className="sources">
              {message.knowledge_sources.map((item, index) =>
                <li key={`${item.document_id}-${index}`}>
                  <button className="knowledge-source" onClick={() => void downloadSource(item)}>
                    <Download size={14} /> [{index + 1}] {item.title}{item.page ? ` · pág. ${item.page}` : ` · ${item.sheet}`}
                  </button>
                </li>
              )}
            </ul>}
            {downloadError && <p className="message-error" role="alert">{downloadError}</p>}
            <div className="message-actions">
              <button className="copy-button" onClick={copy}>{copied ? 'Copiado' : 'Copiar resposta'}</button>
              {message.ticket && original && <button className="workspace-button" onClick={() => convertTicket(original, message.ticket!)}>
                <Ticket size={15} /> Criar chamado
              </button>}
            </div>
          </>
        )}
      </div>
    </article>
  )
}

function App() {
  const [page, setPage] = useState<Page>(pageFromHash)
  const [account, setAccount] = useState<Account | null>()
  const [showAccount, setShowAccount] = useState(false)
  const [ticketDraft, setTicketDraft] = useState<TicketInput | null>(null)
  const [libraryDocument, setLibraryDocument] = useState<LibraryDocument | null>(null)
  const [config, setConfig] = useState<Config | null>(null)
  const [model, setModel] = useState(localStorage.getItem('gai-model') === 'gpt-5-mini' ? 'gpt-5-mini' : 'gpt-5')
  const [history, setHistory] = useState<Conversation[]>([])
  const [current, setCurrent] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [question, setQuestion] = useState('')
  const [mode, setMode] = useState<Mode>('chat')
  const [attachment, setAttachment] = useState<File | null>(null)
  const [pending, setPending] = useState(false)
  const [historyLoading, setLoading] = useState(false)
  const [optimistic, setOptimistic] = useState<Message | null>(null)
  const [error, setError] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const uploadRef = useRef<HTMLInputElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const settingsRef = useRef<HTMLDialogElement>(null)
  const chatButtonRef = useRef(false)
  const shownMessages = optimistic ? [...messages, optimistic] : messages
  const activeKey = keyForAccount(account)
  const displayName = account?.name ?? 'Guilherme'
  const loading = historyLoading || account === undefined

  useEffect(() => {
    let active = true
    getConfig().then((data) => { if (active) setConfig(data) }).catch(() => {})
    getAccount().then((data) => { if (active) setAccount(data) }).catch(() => { if (active) setAccount(null) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const onHashChange = () => { setPage(pageFromHash()); setSidebarOpen(false) }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    if (account === undefined) return
    let active = true
    setHistory([])
    setCurrent(null)
    setMessages([])
    getConversations().then((data) => { if (active) setHistory(data) }).catch(() => {})
    const previous = localStorage.getItem(activeKey)
    if (previous) {
      setLoading(true)
      getConversation(previous).then((data) => {
        if (active) {
          setCurrent(data)
          setMessages(data.messages)
        }
      }).catch(() => {
        if (active) localStorage.removeItem(activeKey)
      }).finally(() => { if (active) setLoading(false) })
    } else setLoading(false)
    return () => { active = false }
  }, [account, activeKey])

  useEffect(() => {
    if (viewportRef.current && shownMessages.length) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight
    }
  }, [messages, optimistic, pending, loading, shownMessages.length, page])

  function navigate(target: Page) {
    setPage(target)
    if (window.location.hash !== navigation[target].hash) window.location.hash = navigation[target].hash
    setSidebarOpen(false)
  }

  function resetComposer() {
    setQuestion('')
    setMode('chat')
    setAttachment(null)
    setLibraryDocument(null)
    setError('')
  }

  function newChat() {
    if (pending || loading) return
    navigate('chat')
    setCurrent(null)
    setMessages([])
    localStorage.removeItem(activeKey)
    resetComposer()
    setSidebarOpen(false)
    inputRef.current?.focus()
  }

  async function openConversation(id: string) {
    navigate('chat')
    if (pending || loading || id === current?.id) {
      setSidebarOpen(false)
      return
    }
    setLoading(true)
    setSidebarOpen(false)
    resetComposer()
    try {
      const data = await getConversation(id)
      setMessages(data.messages)
      setCurrent(data)
      localStorage.setItem(activeKey, id)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }

  function selectTool(selected: Mode) {
    if (pending || loading) return
    const tool = tools.find((item) => item.mode === selected)
    navigate('chat')
    setMode(selected)
    setQuestion(tool?.prompt ?? '')
    setError('')
    setSidebarOpen(false)
    if (selected === 'knowledge') {
      setAttachment(null)
      setLibraryDocument(null)
    }
    if (selected === 'document' && !attachment && !current?.attachment && !libraryDocument) {
      if (page === 'chat') uploadRef.current?.click()
    } else {
      inputRef.current?.focus()
    }
  }

  function selectFile(file: File | undefined) {
    if (!file) return
    if (!/\.(pdf|xlsx)$/i.test(file.name) || !file.size || file.size > 8 * 1024 * 1024) {
      setError('Escolha um PDF ou uma planilha .xlsx com até 8 MB.')
      return
    }
    setAttachment(file)
    setLibraryDocument(null)
    setMode('document')
    setError('')
    inputRef.current?.focus()
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    const text = question.trim()
    if (!text || chatButtonRef.current || loading) return
    if (mode === 'document' && !attachment && !current?.attachment && !libraryDocument) {
      setError('Anexe um PDF ou uma planilha .xlsx para continuar.')
      uploadRef.current?.click()
      return
    }
    chatButtonRef.current = true
    setPending(true)
    setError('')
    setOptimistic({ id: -1, role: 'user', text, attachment: attachment?.name ?? libraryDocument?.name })
    try {
      const result = await sendMessage(text, model, mode, current?.id ?? null, attachment, libraryDocument?.id)
      setMessages((items) => [...items, ...result.messages])
      setCurrent(result.conversation)
      localStorage.setItem(activeKey, result.conversation.id)
      setHistory((items) => [result.conversation, ...items.filter((item) => item.id !== result.conversation.id)])
      resetComposer()
      if (result.messages.at(-1)?.mode === 'knowledge') setMode('knowledge')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setOptimistic(null)
      setPending(false)
      chatButtonRef.current = false
    }
  }

  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }

  function toggleMode(selected: Mode) {
    setMode((value) => value === selected ? 'chat' : selected)
    setError('')
    inputRef.current?.focus()
  }

  function openTicket(input: TicketInput = { ...blankTicket }) {
    setTicketDraft(input)
    navigate('tickets')
  }

  function useLibraryDocument(document: LibraryDocument) {
    if (pending || loading) return
    newChat()
    setLibraryDocument(document)
    setMode('document')
    setQuestion(document.kind === 'pdf' ? 'Resuma este documento.' : 'Qual vendedor vendeu mais?')
  }

  function exportConversation() {
    if (!current) return
    const body = messages.map((message) => {
      const sources = message.sources?.map(({ title, url }) => `- [${title}](${url})`) ?? []
      const references = message.knowledge_sources?.map((source) =>
        `- ${source.title}${source.page ? ` · pág. ${source.page}` : ` · ${source.sheet}`}`) ?? []
      return [
        `## ${message.role === 'user' ? 'Você' : 'GAI Assistant'}`,
        message.attachment && `Arquivo: ${message.attachment}`,
        message.text, [...sources, ...references].join('\n'),
      ].filter(Boolean).join('\n\n')
    }).join('\n\n')
    downloadBlob(new Blob([`# ${current.title}\n\n${body}\n`], { type: 'text/markdown;charset=utf-8' }), 'gai-conversa.md')
  }

  const modeName = modeLabels[mode]
  const visibleAttachment = attachment?.name || libraryDocument?.name ||
    ((mode === 'chat' || mode === 'document') && current?.attachment)
  const hasMessages = Boolean(shownMessages.length)

  return (
    <div className="app-shell">
      {sidebarOpen && <button className="sidebar-overlay" onClick={() => setSidebarOpen(false)} aria-label="Fechar menu" />}
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-brand">
          <Brand />
          <div><strong>GAI Assistant</strong><small>Guilherme AI Assistant</small></div>
          <button className="icon-button close-sidebar" type="button" aria-label="Fechar menu" onClick={() => setSidebarOpen(false)}><X size={20} /></button>
        </div>
        <button className="new-chat" onClick={newChat} disabled={pending || loading}><Plus size={18} /> Nova conversa</button>
        <nav className="sidebar-main" aria-label="Menu do assistente">
          <h2>Operações</h2>
          {(Object.keys(navigation) as Page[]).map((item) => {
            const { icon: Icon, label } = navigation[item]
            const selected = page === item && (page !== 'chat' || mode === 'chat')
            return <button className={`side-item ${selected ? 'selected' : ''}`} key={item}
              aria-current={selected ? 'page' : undefined}
              onClick={() => {
                if (item === 'chat' && !pending) setMode('chat')
                navigate(item)
              }}><Icon size={17} /> {label} <span className="nav-active" /></button>
          })}
          <h2 className="tool-heading">Ferramentas</h2>
          {tools.map(({ mode: toolMode, icon: Icon, label }) => (
            <button className={`side-item ${page === 'chat' && mode === toolMode ? 'selected' : ''}`} key={toolMode}
              disabled={pending || loading} onClick={() => selectTool(toolMode)} title={label}>
              <Icon size={17} /> {({ web: 'Pesquisa web', document: 'PDF e Excel', sql: 'Gerador SQL', ticket: 'Triagem de TI', code: 'Gerador de código', knowledge: 'Consulta à biblioteca' })[toolMode]}
              <span className="nav-active" />
            </button>
          ))}
          <div className="history">
            <h2>Histórico</h2>
            {history.length === 0 && <p>Suas conversas aparecem aqui.</p>}
            {history.map((item) => (
              <button key={item.id} className={`side-item history-item ${item.id === current?.id ? 'current' : ''}`}
                title={item.title} disabled={pending || loading} onClick={() => void openConversation(item.id)}>
                <MessageSquareText size={15} /><span>{item.title}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className="sidebar-footer">
          <div className="avatar" aria-hidden="true">{displayName.trim()[0]?.toLocaleUpperCase('pt-BR') || 'G'}</div>
          <button className="profile profile-button" disabled={pending || account === undefined} onClick={() => setShowAccount(true)}>
            <strong>{displayName}</strong><small>{account ? 'Minha conta' : 'Entrar ou criar conta'}</small>
          </button>
          <button className="icon-button" onClick={() => settingsRef.current?.showModal()} aria-label="Configurações" title="Configurações"><Settings2 size={17} /></button>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">
            <button className="icon-button open-sidebar" onClick={() => setSidebarOpen(true)} aria-label="Abrir menu"><Menu size={21} /></button>
            <span className="workspace-label">Espaço de trabalho</span><ChevronRight className="crumb-divider" size={14} />
            <strong>{navigation[page].label}</strong>
          </div>
          <div className="header-actions">
            {page === 'chat' && config && <button className={`status-pill ${config.live_ai ? 'live' : ''}`} onClick={() => settingsRef.current?.showModal()}>
              <span className="status-dot" /><span className="status-label">{config.live_ai ? 'OpenAI configurada' : 'Modo demonstração'}</span>
            </button>}
            {page === 'chat' && <label className="model-select">
              <Sparkles size={15} /><span className="sr-only">Modelo</span>
              <select value={model} onChange={(event) => { setModel(event.target.value); localStorage.setItem('gai-model', event.target.value) }}
                disabled={pending} aria-label="Modelo">
                {(config?.models ?? defaultModels).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              <ChevronDown size={13} />
            </label>}
            {page === 'chat' && current && <button className="icon-button" type="button" onClick={exportConversation}
              aria-label="Exportar conversa em Markdown" title="Exportar conversa"><Download size={18} /></button>}
            {page !== 'chat' && account !== undefined && <span className="session-pill"
              title={account ? 'Sessão autenticada' : 'Espaço de demonstração'}>
              <Shield size={16} /> {account ? 'Minha conta' : 'Sessão de demonstração'}
            </span>}
          </div>
        </header>

        {page !== 'chat' ? <div className="viewport" key={`${page}-${account?.id ?? 'guest'}`}>
          {account === undefined ? <p className="loading-history" role="status">Carregando espaço de trabalho…</p> : (
            <>
              {page === 'overview' && <OverviewPage name={displayName} navigate={navigate} openTicket={() => openTicket()} />}
              {page === 'tickets' && <TicketsPage initialDraft={ticketDraft} clearDraft={() => setTicketDraft(null)} />}
              {page === 'library' && <LibraryPage useDocument={useLibraryDocument} queryLibrary={() => selectTool('knowledge')} />}
            </>
          )}
        </div> : <div className={`viewport ${hasMessages ? 'chat-viewport' : ''}`} ref={viewportRef} key="chat">
          {loading ? <p className="loading-history" role="status">Carregando conversa…</p> : hasMessages ? (
            <section className="transcript" aria-label="Conversa">
              {shownMessages.map((message, index) => <MessageBlock key={message.id} message={message}
                original={shownMessages[index - 1]?.text}
                convertTicket={(description, classification) => openTicket(draftFromClassification(description, classification))} />)}
              {pending && <div className="pending" role="status"><Brand /><span><i /><i /><i /></span><p>Preparando a resposta…</p></div>}
            </section>
          ) : <Welcome name={displayName} selectTool={selectTool} />}
        </div>}

        {page === 'chat' && <div className="compose-area">
          <form className="composer" onSubmit={(event) => void submit(event)}>
            {error && <div className="compose-error" role="alert"><span>{error}</span><button type="button" className="icon-button" onClick={() => setError('')} aria-label="Dispensar erro"><X size={15} /></button></div>}
            {visibleAttachment && (
              <div className="attachment-row">
                <span className="attachment-pill">
                  {/\.xlsx$/i.test(visibleAttachment) ? <FileSpreadsheet size={15} /> : <FileText size={15} />}
                  <span title={visibleAttachment}>{visibleAttachment}</span>
                  {(attachment || libraryDocument) && <button className="icon-button" type="button" disabled={pending} aria-label="Remover arquivo"
                    onClick={() => { setAttachment(null); setLibraryDocument(null) }}><X size={15} /></button>}
                </span>
              </div>
            )}
            <textarea ref={inputRef} rows={2} value={question} onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={onComposerKey} placeholder="Digite sua pergunta ou descreva uma tarefa…" maxLength={6000}
              aria-label="Digite sua mensagem" disabled={pending || loading} />
            <div className="composer-toolbar">
              <div className="composer-tools">
                <input className="sr-only" tabIndex={-1} ref={uploadRef} type="file" accept=".pdf,.xlsx" aria-label="Selecionar arquivo"
                  onChange={(event) => { selectFile(event.target.files?.[0]); event.target.value = '' }} />
                <button type="button" className="composer-action" disabled={pending || loading} onClick={() => uploadRef.current?.click()}>
                  <Paperclip size={16} /> <span>Anexar arquivo</span>
                </button>
                <button type="button" className={`composer-action ${mode === 'web' ? 'active' : ''}`} disabled={pending || loading}
                  aria-pressed={mode === 'web'} onClick={() => toggleMode('web')}>
                  <Globe2 size={16} /> <span>Pesquisar na web</span>
                </button>
                {modeName && mode !== 'web' && <button type="button" className="composer-action active mode-chip"
                  disabled={pending || loading} onClick={() => toggleMode(mode)} title="Desativar modo">{modeName}<X size={13} /></button>}
              </div>
              <button className="send-button" type="submit" disabled={!question.trim() || pending || loading} aria-label="Enviar mensagem" title="Enviar mensagem"><Send size={17} strokeWidth={2.2} /></button>
            </div>
          </form>
          <p className="composer-note"><CircleHelp size={13} /> Revise informações e código antes de usar.</p>
        </div>}
      </main>

      {showAccount && <AccountDialog account={account ?? null} onClose={() => setShowAccount(false)} onChange={(next) => {
        setShowAccount(false)
        setAccount(next)
        resetComposer()
        setTicketDraft(null)
        navigate('overview')
      }} />}
      <dialog ref={settingsRef} className="settings" onClick={(event) => { if (event.target === event.currentTarget) settingsRef.current?.close() }}>
        <section>
          <div className="settings-heading"><h2>Configurações</h2><button className="icon-button" aria-label="Fechar configurações" onClick={() => settingsRef.current?.close()}><X size={20} /></button></div>
          <p>As chaves de integração são configuradas no servidor.</p>
          <div className="integration"><Sparkles size={18} /><div><strong>OpenAI</strong><small>{config?.live_ai ? 'Respostas com GPT' : 'Respostas de demonstração'}</small></div>{config?.live_ai ? <Check size={17} /> : <Radio size={17} />}</div>
          <div className="integration"><Globe2 size={18} /><div><strong>Tavily</strong><small>{config?.live_web ? 'Pesquisa em tempo real' : 'Chave de pesquisa pendente'}</small></div>{config?.live_web ? <Check size={17} /> : <Radio size={17} />}</div>
        </section>
      </dialog>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
