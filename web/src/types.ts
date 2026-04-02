export interface ProcessWithStatus {
  id: number
  name: string
  project: string
  pid: number
  command: string
  intent: string
  log_file: string
  started_at: string
  cwd: string
  alive: boolean
}
