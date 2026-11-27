import { client } from './api'

export const statusLabels = {
  open: 'Aberto',
  in_progress: 'Em andamento',
  resolved: 'Resolvido',
  closed: 'Encerrado',
} as const
export const priorities = ['Baixa', 'Média', 'Alta', 'Crítica'] as const
export type Status = keyof typeof statusLabels
export type Priority = (typeof priorities)[number]

export interface Classification {
  categoria: string
  sistema: string
  prioridade: Priority
  justificativa: string
  proxima_acao: string
}

export interface TicketInput {
  title: string
  description: string
  system: string
  category: string
  priority: Priority
  status: Status
}

export interface WorkTicket extends TicketInput {
  id: string
  version: number
  due_at: string
  created_at: string
  updated_at: string
  resolved_at: string | null
  overdue: boolean
}

export interface LibraryDocument {
  id: string
  name: string
  description: string
  kind: 'pdf' | 'excel'
  size: number
  units: number
  created_at: string
}

export interface Account {
  id: string
  name: string
  email: string
}

type EventAction = 'conversation_created' | 'ticket_created' | 'ticket_updated' | 'document_added' |
  'document_removed' | 'demo_loaded'

export interface WorkspaceSummary {
  statuses: Record<Status, number>
  active: number
  urgent: number
  overdue: number
  documents: number
  conversations: number
  demo_loaded: boolean
  events: { id: number; action: EventAction; target: string; created_at: string }[]
}

export const getSummary = () => client.get<WorkspaceSummary>('/workspace/summary').then(({ data }) => data)
export const seedDemo = () => client.post('/workspace/demo')
export const getTickets = () => client.get<WorkTicket[]>('/tickets').then(({ data }) => data)
export const createTicket = (input: TicketInput) => client.post<WorkTicket>('/tickets', input).then(({ data }) => data)
export const updateTicket = (id: string, version: number, input: TicketInput) =>
  client.put<WorkTicket>(`/tickets/${id}`, { ...input, version }).then(({ data }) => data)
export const triageTicket = (description: string) =>
  client.post<{ classification: Classification; origin: string }>('/tickets/triage', { description }).then(({ data }) => data)
export const getDocuments = () => client.get<LibraryDocument[]>('/documents').then(({ data }) => data)
export const removeDocument = (id: string) => client.delete(`/documents/${id}`)
export const getAccount = () => client.get<{ account: Account | null }>('/auth/me').then(({ data }) => data.account)
export const authenticate = (operation: 'login' | 'register', input: { name?: string; email: string; password: string }) =>
  client.post<{ account: Account }>(`/auth/${operation}`, input).then(({ data }) => data.account)
export const logout = () => client.post('/auth/logout')

export function uploadDocument(file: File, description: string) {
  const form = new FormData()
  form.set('attachment', file)
  form.set('description', description)
  return client.post<LibraryDocument>('/documents', form).then(({ data }) => data)
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export const exportTickets = () => client.get<Blob>('/tickets/export.csv', { responseType: 'blob' })
  .then(({ data }) => downloadBlob(data, 'gai-chamados.csv'))

export const downloadDocument = (id: string, filename: string) =>
  client.get<Blob>(`/documents/${id}/download`, { responseType: 'blob' }).then(({ data }) => downloadBlob(data, filename))

export const ticketCode = (id: string) => `GAI-${id.slice(0, 8).toUpperCase()}`
const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
export const formatDateTime = (date: string) => dateTime.format(new Date(date))
