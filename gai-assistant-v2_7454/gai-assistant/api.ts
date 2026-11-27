import axios from 'axios'

export type Mode = 'chat' | 'web' | 'document' | 'sql' | 'ticket' | 'code' | 'knowledge'

export interface Conversation {
  id: string
  title: string
  updated_at: string
  attachment: string | null
}

export interface Message {
  id: number
  role: 'user' | 'assistant'
  text: string
  mode?: Mode
  origin?: string
  attachment?: string
  sources?: { title: string; url: string }[]
  knowledge_sources?: { title: string; document_id: string; page?: number; sheet?: string }[]
  ticket?: import('./workspaceApi').Classification
}

export interface Config {
  live_ai: boolean
  live_web: boolean
  models: { id: string; label: string }[]
}

const sessionKey = 'gai-session'
let session = localStorage.getItem(sessionKey)
if (!session) {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  session = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
  localStorage.setItem(sessionKey, session)
}

export const client = axios.create({
  baseURL: '/api',
  headers: { 'X-GAI-Session': session },
  timeout: 115_000,
})

export const getConfig = () => client.get<Config>('/config').then(({ data }) => data)
export const getConversations = () =>
  client.get<Conversation[]>('/conversations').then(({ data }) => data)
export const getConversation = (id: string) =>
  client.get<Conversation & { messages: Message[] }>(`/conversations/${id}`).then(({ data }) => data)

export function sendMessage(question: string, model: string, mode: Mode, id: string | null, file: File | null, documentId?: string) {
  const form = new FormData()
  form.set('question', question)
  form.set('model', model)
  form.set('mode', mode)
  if (id) form.set('conversation_id', id)
  if (file) form.set('attachment', file)
  if (documentId) form.set('document_id', documentId)
  return client.post<{ conversation: Conversation; messages: Message[] }>('/chat', form).then(({ data }) => data)
}

export function errorMessage(error: unknown) {
  if (!axios.isAxiosError(error)) return 'Ocorreu um erro. Tente novamente.'
  const detail = error.response?.data?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) return 'Confira os campos obrigatórios e os limites de tamanho.'
  if (error.code === 'ECONNABORTED') return 'A resposta demorou demais. Tente novamente.'
  return 'Não foi possível conectar ao assistente. Tente novamente.'
}
